const server = require("http").createServer();

const io = require("socket.io")(server);

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

let state = {
  lobbies: {},
};

function createLobby(socket, state) {
  const lobbyCode = getUniqueLobbyCode(state.lobbies);
  const lobby = {
    lobbyCode,
    players: {
      [socket.id]: true,
    },
  };
  state.lobbies[lobbyCode] = lobby;

  // Join room for broadcast later
  socket.join(lobbyCode);

  return lobby;
}

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  socket.on("lobby:create", (data, callback) => {
    console.log("[lobby:create] data", data);

    const lobby = createLobby(socket, state);

    callback(lobby);
  });

  socket.on("lobby:join", ({ lobbyCode }, callback) => {
    console.log(`[lobby:join] ${socket.id} joining lobby ${lobbyCode}`);

    const lobby = state.lobbies[lobbyCode];
    if (!lobby) {
      callback("NOT_FOUND", null);
      return;
    }

    lobby.players[socket.id] = true;
    socket.join(lobbyCode);
    socket.broadcast.to(lobbyCode).emit("lobby:update", lobby);

    callback(null, state.lobbies[lobbyCode]);
  });

  socket.on("disconnect", () => {
    Object.keys(state.lobbies).forEach((lobbyCode) => {
      const lobby = state.lobbies[lobbyCode];
      if (lobby.players[socket.id]) {
        lobby.players[socket.id] = false;
        socket.broadcast.to(lobbyCode).emit("lobby:update", lobby);
      }
    });
  });

  // TODO: disconnect, error handlers
});

const port = 3001;

server.listen(port, (error) => {
  if (error) {
    throw error;
  }
  console.log(`Listening on port ${port}...`);
});
