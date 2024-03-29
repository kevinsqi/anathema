import React from "react";
import { Button } from "react-bootstrap";

import io from "socket.io-client";

function App() {
  const [socket, setSocket] = React.useState(null);
  const [lobby, setLobby] = React.useState(null);
  const [playerId, setPlayerId] = React.useState(null);
  const [
    gameTimeRemainingSeconds,
    setGameTimeRemainingSeconds,
  ] = React.useState(null);

  React.useEffect(() => {
    const newSocket = io.connect("http://localhost:3001");
    setSocket(newSocket);

    newSocket.on("lobby:update", (result) => {
      console.log("lobby:update", result);
      setLobby(result);
    });

    newSocket.on("game:update_timer", (result) => {
      console.log("game:update_timer", result);

      setGameTimeRemainingSeconds(result.timeRemainingSeconds);
    });

    // TODO: close socket on unmount
  }, []);

  if (!socket) {
    return <div>Loading...</div>;
  }

  if (lobby) {
    return (
      <Lobby
        socket={socket}
        lobby={lobby}
        playerId={playerId}
        timeRemainingSeconds={gameTimeRemainingSeconds}
      />
    );
  }

  return (
    <div>
      <h1>Anathema</h1>
      <Button
        variant="primary"
        onClick={() => {
          socket.emit("lobby:create", {}, (err, result) => {
            console.log("lobby:create", result);
            if (err) {
              console.error(err);
              return;
            }

            setLobby(result.lobby);
            setPlayerId(result.playerId);
          });
        }}
      >
        Create lobby
      </Button>

      <JoinLobbyForm
        socket={socket}
        setLobby={setLobby}
        setPlayerId={setPlayerId}
      />
    </div>
  );
}

function Lobby({ lobby, playerId, socket, timeRemainingSeconds }) {
  if (!lobby.game) {
    return (
      <div>
        <h1>Anathema - Lobby {lobby.lobbyCode}</h1>
        {!lobby.game && (
          <ul>
            {Object.keys(lobby.players).map((playerId) => {
              return <li key={playerId}>{playerId}</li>;
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

  const currentRound = lobby.game.rounds[lobby.game.rounds.length - 1];
  const currentActivePlayerId = currentRound.activePlayerId;
  const isActivePlayer = playerId === currentActivePlayerId;
  return (
    <div>
      <h1>Anathema - Lobby {lobby.lobbyCode}</h1>
      <div>
        <ul>
          {Object.keys(lobby.game.scores).map((otherPlayerId) => {
            return (
              <li
                key={otherPlayerId}
                className={
                  otherPlayerId === playerId ? "font-weight-bold" : null
                }
              >
                {otherPlayerId}
                {otherPlayerId === playerId ? " (this is you)" : ""}:{" "}
                {lobby.game.scores[otherPlayerId]}
              </li>
            );
          })}
        </ul>
        {timeRemainingSeconds != null && (
          <div>Time left: {timeRemainingSeconds}</div>
        )}
        <div>
          {isActivePlayer ? (
            `Describe word: ${currentRound.word}`
          ) : (
            <GuessWordForm socket={socket} lobby={lobby} playerId={playerId} />
          )}
        </div>
      </div>
    </div>
  );
}

function GuessWordForm({ socket, lobby, playerId }) {
  const currentRound = lobby.game.rounds[lobby.game.rounds.length - 1];
  const currentActivePlayerId = currentRound.activePlayerId;

  const [guessValue, setGuessValue] = React.useState("");
  const [wrongGuessMessage, setWrongGuessMessage] = React.useState("");

  return (
    <div>
      <p>Guess what word player {currentActivePlayerId} is describing</p>
      <input
        type="text"
        value={guessValue}
        onChange={(event) => setGuessValue(event.target.value)}
      />
      <Button
        variant="primary"
        onClick={() => {
          socket.emit(
            "game:make_guess",
            // TODO: pass a round id as well
            { lobbyCode: lobby.lobbyCode, guessValue, playerId },
            (err, result) => {
              console.log("game:make_guess", result);
              if (err) {
                console.error(err);
                return;
              }

              if (!result.isCorrect) {
                setWrongGuessMessage(`"${result.guessValue}" was not correct`);
                setGuessValue("");
              }
            }
          );
        }}
      >
        Guess
      </Button>
      {wrongGuessMessage !== "" && <div>{wrongGuessMessage}</div>}
    </div>
  );
}

// TODO: allow picking a nickname after joining - then you can rejoin with nickname instead
// of session id
function JoinLobbyForm({ socket, setLobby, setPlayerId }) {
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
            setLobby(result.lobby);
            setPlayerId(result.playerId);
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
