// TODO: fix hella race conditions

const server = require("http").createServer();
const io = require("socket.io")(server, {
  cors: {
    origin: "http://localhost:3000", // TODO: need to change for prod deploy?
    methods: ["GET", "POST"],
  },
});
const _ = require("lodash");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const wordListStr = fs.readFileSync("./data/freevocabulary_words.json");
const wordList = JSON.parse(wordListStr);

// Durstenfeld Shuffle
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function createLobbyCode() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  shuffleArray(letters);
  return letters.slice(0, 5).join("");
}

function getUniqueLobbyCode(lobbies) {
  for (let i = 0; i < 20; i++) {
    const lobbyCode = createLobbyCode();
    if (!state.lobbies[lobbyCode]) {
      return lobbyCode;
    }
  }
  throw new Error("Failed to create unique lobby code");
}

// TODO: persist state in some key value store
let state = {
  lobbies: {},
};

function createGame(io, lobby, { gameDurationSeconds, gameWinningScore }) {
  const gameId = uuidv4();
  io.in(lobby.lobbyCode).emit("game:update_timer", {
    timeRemainingSeconds: gameDurationSeconds,
  });
  const timerIntervalId = setInterval(() => {
    const currentTimeSeconds = new Date().getTime() / 1000;

    // If game has expired or ended, clear timer
    const isGameEnded = !lobby.game || lobby.game.gameId !== gameId;
    if (isGameEnded) {
      clearInterval(timerIntervalId);
      return;
    }
    const timeElapsed = Math.round(
      currentTimeSeconds - lobby.game.gameStartSeconds
    );
    const isGameTimedOut = timeElapsed && timeElapsed > gameDurationSeconds;
    if (isGameTimedOut) {
      clearInterval(timerIntervalId);
      return;
    }

    io.in(lobby.lobbyCode).emit("game:update_timer", {
      timeRemainingSeconds: gameDurationSeconds - timeElapsed,
    });
  }, 1000);

  const timeoutId = setTimeout(() => {
    // If the game has already ended, do a no-op
    if (!lobby.game || lobby.game.gameId !== gameId) {
      return;
    }
    endGame(io, lobby);
    clearInterval(timerIntervalId);
  }, gameDurationSeconds * 1000);

  lobby.game = {
    gameId,
    gameStartSeconds: new Date().getTime() / 1000,
    gameWinningScore,
    scores: Object.keys(lobby.players).reduce((obj, playerId) => {
      obj[playerId] = 0;
      return obj;
    }, {}),
    rounds: [],
  };

  const firstActivePlayerId = Object.keys(lobby.players)[0];
  // TODO: setInterval
  createRound(lobby, firstActivePlayerId);

  return lobby;
}

function endGame(io, lobby) {
  console.log("[endGame]", lobby);

  // TODO: persist game
  lobby.game = null;

  // TODO: cancel interval, cancel timeout
  io.in(lobby.lobbyCode).emit("lobby:update", lobby);
}

function createRound(lobby, activePlayerId) {
  const wordItem = _.sample(wordList);

  lobby.game.rounds.push({
    word: wordItem.word,
    activePlayerId,
    guesses: [],
  });
}

function makeGuess(lobby, playerId, guessValue) {
  const currentRound = lobby.game.rounds[lobby.game.rounds.length - 1];

  if (playerId === currentRound.activePlayerId) {
    console.error("INVALID_GUESS_ACTIVE_PLAYER_CANNOT_GUESS");
    return false;
  }
  const isCorrect = guessValue === currentRound.word;

  currentRound.guesses.push({
    playerId,
    guessValue,
    isCorrect,
  });

  if (isCorrect) {
    lobby.game.scores[playerId] += 1;
    createRound(lobby, playerId);
    return true;
  }

  return false;
}

function createLobby(socket, state) {
  const lobbyCode = getUniqueLobbyCode(state.lobbies);
  const lobby = {
    lobbyCode,
    players: {
      [socket.id]: true,
    },
  };
  state.lobbies[lobbyCode] = lobby;

  return lobby;
}

function isGameComplete(lobby) {
  if (!lobby.game) {
    return true;
  }

  const maxScore = Math.max(...Object.values(lobby.game.scores));
  return maxScore >= lobby.game.gameWinningScore;
}

// Note which emits skip the sender
// https://socket.io/docs/v3/emit-cheatsheet/
io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  socket.on("lobby:create", (data, callback) => {
    console.log("[lobby:create] data", data);

    const lobby = createLobby(socket, state);
    const playerId = socket.id;

    // Join room for broadcast later
    socket.join(lobby.lobbyCode);

    callback(null, { lobby, playerId });
  });

  socket.on("lobby:join", ({ lobbyCode }, callback) => {
    console.log(`[lobby:join] ${socket.id} joining lobby ${lobbyCode}`);

    const lobby = state.lobbies[lobbyCode];
    if (!lobby) {
      callback("NOT_FOUND", null);
      return;
    }

    const playerId = socket.id;
    lobby.players[playerId] = true;
    if (lobby.game) {
      lobby.game.scores[playerId] = 0;
    }

    socket.join(lobbyCode);
    io.in(lobbyCode).emit("lobby:update", lobby);

    callback(null, { lobby: state.lobbies[lobbyCode], playerId });
  });

  socket.on("game:start", ({ lobbyCode }, callback) => {
    console.log(`[game:start] Lobby ${lobbyCode}`);

    const lobby = state.lobbies[lobbyCode];
    const gameDurationSeconds = 60 * 5;
    const gameWinningScore = 1;
    createGame(io, lobby, { gameDurationSeconds, gameWinningScore });

    io.in(lobbyCode).emit("lobby:update", lobby);

    callback(null, null);
  });

  socket.on("game:make_guess", (params, callback) => {
    console.log("[game:make_guess] Called", params);
    const { lobbyCode, guessValue, playerId } = params;

    const lobby = state.lobbies[lobbyCode];
    const isCorrect = makeGuess(lobby, playerId, guessValue);

    if (isGameComplete(lobby)) {
      console.log("[game:make_guess] Game complete via guessing");
      endGame(io, lobby);
    }

    io.in(lobbyCode).emit("lobby:update", lobby);

    callback(null, { isCorrect, guessValue });
  });

  socket.on("disconnect", () => {
    Object.keys(state.lobbies).forEach((lobbyCode) => {
      const lobby = state.lobbies[lobbyCode];
      if (lobby.players[socket.id]) {
        lobby.players[socket.id] = false;
        io.in(lobbyCode).emit("lobby:update", lobby);
      }
    });
  });

  // TODO: disconnect, error handlers
});

// TODO: use env var PORT
const port = 3001;

server.listen(port, (error) => {
  if (error) {
    throw error;
  }
  console.log(`Listening on port ${port}...`);
});
