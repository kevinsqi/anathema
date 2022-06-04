import React from "react";
import { Button } from "react-bootstrap";

import io from "socket.io-client";

function App() {
  const [socket, setSocket] = React.useState(null);
  const [lobby, setLobby] = React.useState(null);

  React.useEffect(() => {
    const newSocket = io.connect("http://localhost:3001");
    setSocket(newSocket);

    newSocket.on("lobby:update", (result) => {
      console.log("lobby:update", result);
      setLobby(result);
    });

    // TODO: close socket on unmount
  }, []);

  if (!socket) {
    return <div>Loading...</div>;
  }

  if (lobby) {
    return <Lobby socket={socket} lobby={lobby} />;
  }

  return (
    <div>
      <h1>Anathema</h1>
      <Button
        variant="primary"
        onClick={() => {
          socket.emit("lobby:create", {}, (result) => {
            console.log("lobby:create", result);
            setLobby(result);
          });
        }}
      >
        Create lobby
      </Button>

      <JoinLobbyForm socket={socket} setLobby={setLobby} />
    </div>
  );
}

function Lobby({ lobby, socket }) {
  return (
    <div>
      <h1>Anathema - Lobby {lobby.lobbyCode}</h1>
      <ul>
        {Object.keys(lobby.players).map((playerId) => {
          return <li key={playerId}>{playerId}</li>;
        })}
      </ul>

      {lobby.game && (
        <ul>
          {Object.keys(lobby.game.scores).map((playerId) => {
            return (
              <li key={playerId}>
                {playerId}: {lobby.game.scores[playerId]}
              </li>
            );
          })}
        </ul>
      )}

      <Button
        variant="primary"
        onClick={() => {
          socket.emit(
            "game:start",
            { lobbyCode: lobby.lobbyCode },
            (err, result) => {
              console.log("game:start", result);
              if (err) {
                console.error(err);
                return;
              }
            }
          );
        }}
      >
        Start new game
      </Button>
    </div>
  );
}

// TODO: allow picking a nickname after joining - then you can rejoin with nickname instead
// of session id
function JoinLobbyForm({ socket, setLobby }) {
  const [lobbyCode, setLobbyCode] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState(null);
  return (
    <div>
      <input
        type="text"
        value={lobbyCode}
        onChange={(event) => setLobbyCode(event.target.value)}
      />
      <Button
        variant="primary"
        onClick={() => {
          socket.emit("lobby:join", { lobbyCode }, (err, result) => {
            console.log("lobby:join", result);
            if (err) {
              console.error(err);
              if (err === "NOT_FOUND") {
                setErrorMessage("Lobby not found");
              }
              return;
            }
            setLobby(result);
          });
        }}
      >
        Join lobby
      </Button>
      {errorMessage && <div>{errorMessage}</div>}
    </div>
  );
}

export default App;
