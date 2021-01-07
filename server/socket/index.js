const _ = require('lodash');
const http = require('http');
const bcrypt = require('bcrypt');
const socketIO = require('socket.io');
const expressSocketSession = require('express-socket.io-session');
const logger = require('../logger');
const Protocol = require('../../client/src/lib/protocol.js');
const { User, Room } = require('../models');
const ChatMessage = require('./ChatMessage');

const publicRoomKeys = ['_id', 'name', 'event', 'usersLength', 'private', 'type', 'admin', 'requireRevealedIdentity', 'startTime', 'started'];
const privateRoomKeys = [...publicRoomKeys, 'users', 'competing', 'waitingFor', 'banned', 'attempts', 'admin', 'accessCode', 'inRoom', 'registered', 'nextSolveAt'];

// Data for people not in room
const roomMask = (room) => ({
  ..._.partial(_.pick, _, publicRoomKeys)(room),
  users: room.private ? undefined : room.usersInRoom.map((user) => user.displayName),
});

// Data for people in room
const joinRoomMask = _.partial(_.pick, _, privateRoomKeys);

// Keep track of users using multiple sockets.
// Map of user.id -> {room.id: [socket.id]}
const SocketUsers = {};

let usersOnline = 0;

const fetchRoom = async (id) => {
  if (id) {
    try {
      return await Room.findById({ _id: id });
    } catch (e) {
      logger.error(e, { roomId: id });
    }
  }
};

async function attachUser(socket, next) {
  const userId = socket.handshake.session.passport ? socket.handshake.session.passport.user : null;

  if (!userId) {
    return next();
  }

  socket.userId = userId;

  if (!SocketUsers[socket.userId]) {
    SocketUsers[socket.userId] = {};
  }

  try {
    socket.user = await User.findOne({ id: socket.userId });
  } catch (e) {
    logger.error(e, { userId: socket.userId });
  }

  next();
}

const getRooms = (userId) => Room.find()
  .then((rooms) => rooms.filter((room) => (
    userId ? !room.banned.get(userId.toString()) : true
  )).map(roomMask));
// give them the list of rooms

const roomTimerObj = {};

module.exports = ({ app, expressSession }) => {
  const server = http.Server(app);
  const io = socketIO(server);
  app.io = io;

  io.use(expressSocketSession(expressSession, {
    autoSave: true,
  }));

  io.use(attachUser);

  io.use((socket, next) => {
    socket.use(([event, data], n) => {
      logger.info(event, {
        id: socket.id,
        userId: socket.userId,
        roomId: socket.roomId,
        data,
      });

      n();
    });

    next();
  });

  io.use((socket, next) => {
    socket.use(async (packet, n) => {
      if (socket.userId) {
        try {
          socket.user = await User.findOne({ id: socket.userId });
        } catch (e) {
          logger.error(e, { userId: socket.userId });
        }
      }

      if (socket.roomId) {
        socket.room = await fetchRoom(socket.roomId);
      }

      n();
    });
    next();
  });

  function broadcastToEveryone(...args) {
    io.emit(...args);
  }

  function broadcastToAllInRoom(accessCode, event, data) {
    io.in(accessCode).emit(event, data);
  }

  function sendNewScramble(room) {
    return room.newAttempt().then((r) => {
      logger.debug('Sending new scramble to room', { roomId: room.id });
      broadcastToAllInRoom(room.accessCode, Protocol.NEW_ATTEMPT, {
        waitingFor: r.waitingFor,
        attempt: r.attempts[r.attempts.length - 1],
      });

      return r;
    });
  }

  const interval = 60 * 1000; // 30 seconds

  function startTimer(room) {
    if (!room) {
      logger.error('Attempting to start undefined room');
      return;
    }

    const newSolve = () => {
      Room.findById(room._id).then(async (r) => {
        if (!r) {
          return;
        }

        const nextSolveAt = new Date(Date.now() + interval);
        logger.debug('nextSolveAt', { nextSolveAt });
        await sendNewScramble(r);
        r.nextSolveAt = nextSolveAt;
        await r.save();
        broadcastToAllInRoom(room.accessCode, Protocol.NEXT_SOLVE_AT, nextSolveAt);
      });
    };

    roomTimerObj[room._id] = setInterval(() => {
      newSolve();
    }, interval);

    const nextSolveAt = new Date(Date.now() + interval);
    logger.info('Starting timer for room; first solve at: ', { roomId: room._id, nextSolveAt });
    broadcastToAllInRoom(room.accessCode, Protocol.NEXT_SOLVE_AT, nextSolveAt);
    room.nextSolveAt = nextSolveAt;
    room.save();
  }

  function awaitRoomStart(room) {
    const time = new Date(room.startTime).getTime() - Date.now();
    logger.debug('Starting countdown for room', {
      roomId: room._id,
      milliseconds: time,
    });

    setTimeout(() => {
      Room.findById(room._id).then((r) => {
        r.start().then((rr) => {
          broadcastToAllInRoom(rr.accessCode, Protocol.UPDATE_ROOM, joinRoomMask(rr));
          startTimer(rr);
        });
      });
    }, time);
  }

  function pauseTimer(room) {
    clearInterval(roomTimerObj[room._id]);
  }

  Room.find({ type: 'grand_prix' })
    .then((rooms) => {
      rooms.forEach(async (room) => {
        if (room.startTime && Date.now() < new Date(room.startTime).getTime()) {
          awaitRoomStart(room);
        } else {
          startTimer(room);
        }
      });
    });

  io.sockets.on('connection', (socket) => {
    logger.debug(`socket ${socket.id} connected; logged in as ${socket.user ? socket.user.name : 'Anonymous'}`);

    getRooms(socket.userId)
      .then((rooms) => {
        socket.emit(Protocol.UPDATE_ROOMS, rooms);
      });

    function broadcast(...args) {
      socket.broadcast.to(socket.room.accessCode).emit(...args);
    }

    // New user online
    usersOnline = Object.keys(SocketUsers).length;
    if (usersOnline > 0) {
      broadcastToEveryone(Protocol.UPDATE_USER_COUNT, usersOnline);
    }
    logger.debug(`Users online: ${usersOnline}`);

    function isLoggedIn() {
      if (!socket.user) {
        socket.emit(Protocol.ERROR, {
          statusCode: 403,
          message: 'Must be logged in',
        });
      }
      return !!socket.user;
    }

    function isInRoom() {
      if (!socket.room) {
        socket.emit(Protocol.ERROR, {
          statusCode: 400,
          message: 'Must be in a room',
        });
      }
      return !!socket.room;
    }

    function checkAdmin() {
      if (!isLoggedIn() || !isInRoom()) {
        return false;
      } if (socket.room.admin.id !== socket.user.id) {
        socket.emit(Protocol.ERROR, {
          statusCode: 403,
          message: 'Must be admin of room',
        });
        return false;
      }
      return true;
    }

    // Only deals with removing authenticated users from a room
    async function leaveRoom() {
      // only socket on this user id
      if (!SocketUsers[socket.userId]) {
        logger.error('Reference to users\' socket lookup is undefined for some reason');
        return;
      }

      if (!SocketUsers[socket.userId][socket.roomId]
        || SocketUsers[socket.userId][socket.roomId].length === 0) {
        logger.warn(`SocketUsers[${socket.userId}][${socket.roomId}] has length 0 for some reason`, SocketUsers[socket.userId]);
        return;
      }

      SocketUsers[socket.userId][socket.roomId].splice(
        SocketUsers[socket.userId][socket.roomId].indexOf(socket.id), 1,
      );

      if (SocketUsers[socket.userId][socket.roomId].length > 0) {
        return;
      }

      try {
        const room = await socket.room.dropUser(socket.user, (_room) => {
          broadcastToAllInRoom(socket.room.accessCode, Protocol.UPDATE_ADMIN, _room.admin);
        });

        broadcast(Protocol.USER_LEFT, socket.user.id);
        broadcastToEveryone(Protocol.GLOBAL_ROOM_UPDATED, roomMask(room));

        if (room.doneWithScramble()) {
          logger.debug('everyone done, sending new scramble');
          sendNewScramble(room);
        }

        delete SocketUsers[socket.user.id][room._id];
      } catch (e) {
        logger.error(e);
      }
    }

    function joinRoom(room, cb, spectating) {
      if (socket.room) {
        logger.debug('Socket is already in room', { roomId: socket.room._id });
        return;
      }

      if (room.banned.get(socket.userId.toString())) {
        logger.debug(`Banned user ${socket.user.id} is trying to join room ${room._id}`);
        socket.emit(Protocol.ERROR, {
          statusCode: 403,
          event: Protocol.JOIN_ROOM,
          message: 'Banned',
        });
        socket.emit(Protocol.FORCE_LEAVE);
        return;
      }

      if (room.requireRevealedIdentity && !socket.user.showWCAID) {
        socket.emit(Protocol.ERROR, {
          statusCode: 403,
          event: Protocol.JOIN_ROOM,
          message: 'Must be showing WCA Identity to join room.',
        });
        socket.emit(Protocol.FORCE_LEAVE);
        return;
      }

      socket.join(room.accessCode, async () => {
        socket.roomId = room._id;

        if (!socket.user) {
          logger.debug('Socket is not authenticated but joining anyways', { roomId: room._id, userId: socket.userId });
          socket.emit(Protocol.JOIN, joinRoomMask(room));
          return;
        }

        if (!SocketUsers[socket.user.id][room._id]) {
          SocketUsers[socket.user.id][room._id] = [];
        }

        SocketUsers[socket.user.id][room._id].push(socket);

        const r = await room.addUser(socket.user, spectating, (_room) => {
          broadcastToAllInRoom(_room.accessCode, Protocol.UPDATE_ADMIN, _room.admin);
        });

        if (!r) {
          // Join the socket to the room anyways but don't add them
          socket.emit(Protocol.JOIN, joinRoomMask(room));
          return;
        }

        socket.room = r;
        socket.emit(Protocol.JOIN, joinRoomMask(r));

        if (cb) cb(r);

        broadcast(Protocol.USER_JOIN, socket.user); // tell everyone
        broadcastToEveryone(Protocol.GLOBAL_ROOM_UPDATED, roomMask(r));

        if (room.doneWithScramble()) {
          logger.debug('everyone done, sending new scramble');
          sendNewScramble(room);
        }
      });
    }

    // Socket wants to join room.
    socket.on(Protocol.JOIN_ROOM, async ({ id, password }) => {
      try {
        const room = await Room.findById(id);
        if (!room) {
          socket.emit(Protocol.ERROR, {
            statusCode: 404,
            message: `Could not find room with id ${id}`,
          });
          return;
        }

        if (room.private && !room.authenticate(password)) {
          socket.emit(Protocol.ERROR, {
            statusCode: 403,
            event: Protocol.JOIN_ROOM,
            message: 'Invalid password',
          });
          return;
        }

        joinRoom(room);
      } catch (e) {
        logger.error(e);
      }
    });

    // Given ID, fetches room, authenticates, and returns room data.
    socket.on(Protocol.FETCH_ROOM, async (id, spectating, password) => {
      const room = await Room.findById(id);

      if (!room) {
        socket.emit(Protocol.ERROR, {
          statusCode: 404,
          event: Protocol.FETCH_ROOM,
          message: `Could not find room with id ${id}`,
        });
      } else if (room.private && password && room.authenticate(password)) {
        joinRoom(room, () => {}, spectating);
      } else if (room.private) {
        socket.emit(Protocol.UPDATE_ROOM, roomMask(room));
      } else {
        joinRoom(room, () => {}, spectating);
      }
    });

    socket.on(Protocol.CREATE_ROOM, async (options) => {
      if (!isLoggedIn()) {
        return;
      }

      const newRoom = new Room({
        name: options.name,
        type: options.type,
        requireRevealedIdentity: options.requireRevealedIdentity,
        startTime: options.startTime ? new Date(options.startTime) : null,
      });

      if (options.password) {
        newRoom.password = bcrypt.hashSync(options.password, bcrypt.genSaltSync(5));
      }

      newRoom.owner = socket.user;

      const room = await newRoom.save();
      io.emit(Protocol.ROOM_CREATED, roomMask(room));
      await joinRoom(room, (r) => {
        if (r.type === 'grand_prix' && !r.started) {
          return;
        }

        sendNewScramble(r);
      });

      socket.emit(Protocol.FORCE_JOIN, room);

      if (room.type === 'grand_prix' && room.startTime) {
        awaitRoomStart(room);
      }
    });

    /* Admin Actions */
    socket.on(Protocol.DELETE_ROOM, async (id) => {
      if (!checkAdmin() && +socket.userId !== 8184) {
        return;
      }

      Room.deleteOne({ _id: id }).then((res) => {
        if (res.deletedCount > 0) {
          socket.room = undefined;
          broadcastToEveryone(Protocol.ROOM_DELETED, id);
        } else if (res.deletedCount > 1) {
          logger.error(168, 'big problemo');
        }
      });
    });

    // Register user for room they are currently in
    socket.on(Protocol.UPDATE_REGISTRATION, async (registration) => {
      if (!isLoggedIn() || !isInRoom()) {
        return;
      }

      try {
        const room = await socket.room.updateRegistration(socket.userId, registration);

        broadcastToAllInRoom(room.accessCode, Protocol.UPDATE_ROOM, joinRoomMask(room));
      } catch (e) {
        logger.error(e);
      }
    });

    // Register user for room they are currently in
    socket.on(Protocol.UPDATE_USER, async ({ userId, competing, registered }) => {
      if (!checkAdmin()) {
        return;
      }

      try {
        if (competing !== undefined) {
          socket.room.competing.set(userId.toString(), competing);
        }

        if (registered !== undefined) {
          socket.room.registered.set(userId.toString(), registered);
        }

        const room = await socket.room.save();

        broadcastToAllInRoom(room.accessCode, Protocol.UPDATE_ROOM, joinRoomMask(room));
      } catch (e) {
        logger.error(e);
      }
    });

    socket.on(Protocol.SUBMIT_RESULT, async ({ id, result }) => {
      if (!socket.user || !socket.roomId) {
        return;
      }

      try {
        if (!socket.room.attempts[id]) {
          socket.emit(Protocol.ERROR, {
            statusCode: 400,
            event: Protocol.SUBMIT_RESULT,
            message: 'Invalid ID for attempt submission',
          });
          return;
        }

        if (socket.room.type === 'grand_prix') {
          result.penalties.DNF = result.penalties.DNF
            || id < socket.room.attempts.length - 1;
        }
        socket.room.attempts[id].results.set(socket.user.id.toString(), result);
        socket.room.waitingFor.splice(socket.room.waitingFor.indexOf(socket.userId), 1);

        const r = await socket.room.save();

        broadcastToAllInRoom(r.accessCode, Protocol.NEW_RESULT, {
          id,
          result,
          userId: socket.user.id,
        });

        if (r.doneWithScramble()) {
          logger.debug('everyone done, sending new scramble');
          sendNewScramble(r);
        }
      } catch (e) {
        logger.error(e);
      }
    });

    socket.on(Protocol.SEND_EDIT_RESULT, async (result) => {
      if (!socket.user || !socket.roomId) {
        return;
      }

      try {
        if (!socket.room.attempts[result.id]) {
          socket.emit(Protocol.ERROR, {
            statusCode: 400,
            event: Protocol.SEND_EDIT_RESULT,
            message: 'Invalid ID for result modification',
          });
          return;
        }

        const { userId } = result;
        if (userId !== socket.user.id && socket.user.id !== socket.room.admin.id) {
          socket.emit(Protocol.ERROR, {
            statusCode: 400,
            event: Protocol.SEND_EDIT_RESULT,
            message: 'Invalid permissions to edit result',
          });
          return;
        }

        socket.room.attempts[result.id].results.set(userId.toString(), result.result);

        const r = await socket.room.save();

        broadcastToAllInRoom(r.accessCode, Protocol.EDIT_RESULT, {
          ...result,
          userId,
        });
      } catch (e) {
        logger.error(e);
      }
    });

    socket.on(Protocol.REQUEST_SCRAMBLE, async () => {
      if (!checkAdmin()) {
        return;
      }

      sendNewScramble(socket.room);
    });

    socket.on(Protocol.CHANGE_EVENT, async (event) => {
      if (!checkAdmin()) {
        return;
      }

      socket.room.changeEvent(event).then((r) => {
        broadcastToAllInRoom(r.accessCode, Protocol.UPDATE_ROOM, joinRoomMask(socket.room));
      }).catch(logger.error);
    });

    socket.on(Protocol.EDIT_ROOM, async (options) => {
      if (!checkAdmin()) {
        return;
      }

      try {
        const room = await socket.room.edit(options);
        broadcastToAllInRoom(room.accessCode, Protocol.UPDATE_ROOM, joinRoomMask(room));

        Room.find().then((rooms) => {
          broadcastToEveryone(Protocol.UPDATE_ROOMS, rooms.map(roomMask));
        });
      } catch (e) {
        (logger.error(e));
      }
    });

    socket.on(Protocol.START_ROOM, async () => {
      if (!checkAdmin()) {
        return;
      }

      const room = await socket.room.start();
      try {
        startTimer(room);
        broadcastToAllInRoom(socket.room.accessCode, Protocol.UPDATE_ROOM, joinRoomMask(room));
      } catch (e) {
        logger.error(e);
      }
    });

    socket.on(Protocol.PAUSE_ROOM, async () => {
      if (!checkAdmin()) {
        return;
      }

      pauseTimer(await socket.room.pause());

      broadcastToAllInRoom(socket.room.accessCode, Protocol.UPDATE_ROOM, joinRoomMask(socket.room));
    });

    socket.on(Protocol.KICK_USER, async (userId) => {
      if (!checkAdmin()) {
        return;
      }

      if (!SocketUsers[userId]) {
        logger.debug('Invalid user to kick', { userId });
        return;
      }

      if (!SocketUsers[userId][socket.roomId]) {
        logger.debug('Invalid room to kick user from', { roomId: socket.roomId });
        return;
      }

      await Promise.all(
        SocketUsers[userId][socket.roomId].map((s) => {
          io.to(s.id).emit(Protocol.FORCE_LEAVE);
          return new Promise((resolve) => {
            s.leave(socket.room.accessCode, () => {
              resolve();
            });
          });
        }),
      );

      try {
        const room = await socket.room.dropUser({ id: userId });

        if (!room) {
          logger.debug('User ban failed for some reason');
        }

        broadcastToAllInRoom(socket.room.accessCode, Protocol.USER_LEFT, userId);
        broadcastToEveryone(Protocol.GLOBAL_ROOM_UPDATED, roomMask(room));

        if (room.doneWithScramble()) {
          logger.debug('everyone done, sending new scramble');
          sendNewScramble(room);
        }

        delete SocketUsers[userId][room._id];
      } catch (e) {
        logger.error(e);
      }
    });

    socket.on(Protocol.BAN_USER, async (userId) => {
      if (!checkAdmin()) {
        return;
      }

      if (!SocketUsers[userId]) {
        logger.debug('Invalid user to ban', { userId });
        return;
      }

      // If any sockets for this user and in the room, kick them
      if (SocketUsers[userId][socket.roomId]) {
        await Promise.all(
          SocketUsers[userId][socket.roomId].map((s) => {
            io.to(s.id).emit(Protocol.FORCE_LEAVE);
            return new Promise((resolve) => {
              s.leave(socket.room.accessCode, () => {
                resolve();
              });
            });
          }),
        );
      }

      try {
        const room = await socket.room.banUser(userId);

        if (!room) {
          logger.debug('User ban failed for some reason');
        }

        broadcastToAllInRoom(room.accessCode, Protocol.UPDATE_ROOM, joinRoomMask(room));
        broadcastToEveryone(Protocol.GLOBAL_ROOM_UPDATED, roomMask(room));

        if (room.doneWithScramble()) {
          logger.debug('everyone done, sending new scramble');
          sendNewScramble(room);
        }

        delete SocketUsers[userId][room._id];
      } catch (e) {
        logger.error(e);
      }
    });

    socket.on(Protocol.UNBAN_USER, async (userId) => {
      if (!checkAdmin()) {
        return;
      }

      if (!SocketUsers[socket.userId]) {
        logger.debug('Invalid user to unban', { userId });
        return;
      }

      if (!SocketUsers[socket.userId][socket.roomId]) {
        logger.debug('Invalid room to unban user from', { roomId: socket.roomId });
        return;
      }

      try {
        const room = await socket.room.unbanUser(userId);

        if (!room) {
          logger.debug('User unban failed for some reason');
        }

        broadcastToAllInRoom(room.accessCode, Protocol.UPDATE_ROOM, joinRoomMask(room));
        broadcastToEveryone(Protocol.GLOBAL_ROOM_UPDATED, roomMask(room));
      } catch (e) {
        logger.error(e);
      }
    });


    // Simplest event here. Just echo the message to everyone else.
    socket.on(Protocol.MESSAGE, (message) => {
      if (!isLoggedIn() || !isInRoom()) {
        return;
      }

      broadcastToAllInRoom(socket.room.accessCode, Protocol.MESSAGE,
        new ChatMessage(message.text, socket.user.id));
    });

    // Simplest event here. Just echo the message to everyone else.
    socket.on(Protocol.UPDATE_STATUS, (status) => {
      if (!isLoggedIn() || !isInRoom()) {
        return;
      }

      broadcast(Protocol.UPDATE_STATUS, status);
    });

    socket.on(Protocol.DISCONNECT, async () => {
      logger.debug(`socket ${socket.id} disconnected; Left room: ${socket.room ? socket.room.name : 'Null'}`);

      if (socket.roomId) {
        socket.room = await fetchRoom(socket.roomId);
      }

      if (socket.user && socket.room) {
        await leaveRoom();
      }

      if (socket.userId) {
        if (Object.keys(SocketUsers[socket.userId]).length === 0) {
          delete SocketUsers[socket.userId];
        }

        usersOnline = Object.keys(SocketUsers).length;
        logger.debug(`Users online: ${usersOnline}`);

        if (usersOnline > 0) {
          broadcastToEveryone(Protocol.UPDATE_USER_COUNT, usersOnline);
        }
      }
    });

    socket.on(Protocol.LEAVE_ROOM, async () => {
      if (socket.room) {
        socket.leave(socket.room.accessCode);
      }

      if (isLoggedIn() && isInRoom()) {
        await leaveRoom();
      }

      delete socket.room;
      delete socket.roomId;
    });

    // option is a true or false value of whether or not they're kibitzing
    socket.on(Protocol.UPDATE_COMPETING, async (competing) => {
      if (!isLoggedIn() || !isInRoom()) {
        return;
      }

      broadcastToAllInRoom(socket.room.accessCode, Protocol.UPDATE_COMPETING, {
        userId: socket.userId,
        competing,
      });

      socket.room.competing.set(socket.userId.toString(), competing);

      if (competing) {
        await socket.room.save();

        const { users } = socket.room;

        // We went from no one competing to 1 person competing, give them a scramble.
        if (users.filter((user) => socket.room.competing.get(user.id.toString())).length === 1) {
          // if the lone user that is now competing hasn't done the attempt, let them doing it.
          // Else, gen a new scramble.
          const latest = socket.room.attempts[socket.room.attempts.length - 1];
          if (!latest.results.get(socket.userId.toString())) {
            socket.room.waitingFor.push(socket.userId);
            broadcastToAllInRoom(socket.room.accessCode, Protocol.UPDATE_ROOM,
              joinRoomMask(socket.room));
          } else if (socket.room.doneWithScramble()) {
            logger.debug('everyone done because user kibitzed, sending new scramble');
            sendNewScramble(socket.room);
          }
        }
      } else {
        socket.room.waitingFor.splice(socket.room.waitingFor.indexOf(socket.userId), 1);

        await socket.room.save();

        if (socket.room.doneWithScramble()) {
          logger.debug('everyone done because user kibitzed, sending new scramble');
          sendNewScramble(socket.room);
        }
      }
    });
  });

  return server;
};
