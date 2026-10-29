import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

import {
  GomokuGameInstance,
  PLAYER_BLACK,
  PLAYER_WHITE
} from "../dist-electron/games/gomokuEngine.js";
import {
  XiangqiGameInstance
} from "../dist-electron/games/xiangqiEngine.js";
import {
  dispatchGameAction,
  getOrCreateGame,
  handlePlayerMove,
  handleAgentMove,
  handleGetGameState,
  initGamePersistence
} from "../dist-electron/gameToolService.js";
import { createGameMcpServer } from "../dist-electron/mcp/gameMcpServer.js";

test("Game MCP server creates properly with expected tools", () => {
  const server = createGameMcpServer();
  assert.ok(server);
});

test("Game tool service dispatches actions correctly", async () => {
  const conversationId = `conv-test-${Date.now()}`;
  const binding = {
    token: "test-token",
    taskSessionId: "session-1",
    conversationId,
    gameType: "gomoku"
  };

  // 1. Get initial state
  const stateRes = await dispatchGameAction(binding, "get_state", {});
  assert.equal(stateRes.ok, true);
  assert.ok(stateRes.gameState);
  assert.equal(stateRes.gameState.gameType, "gomoku");
  assert.equal(stateRes.gameState.turn, PLAYER_BLACK);
  assert.equal(stateRes.gameState.legalMoves.length > 0, true);

  // 2. Player makes a move: H8
  const playerRes = handlePlayerMove(conversationId, "H8");
  assert.equal(playerRes.ok, true);
  assert.equal(playerRes.gameState.turn, PLAYER_WHITE);
  assert.equal(playerRes.gameState.board[7][7], PLAYER_BLACK);

  // 3. Agent attempts illegal move on occupied H8
  const illegalRes = await dispatchGameAction(binding, "make_move", {
    actionId: "H8"
  });
  assert.equal(illegalRes.ok, false);
  assert.match(illegalRes.error, /already occupied/i);

  // 4. Agent makes legal move: H9
  const legalMoveRes = await dispatchGameAction(binding, "make_move", {
    actionId: "H9",
    reason: "抢占中路邻近要点"
  });
  assert.equal(legalMoveRes.ok, true);
  assert.equal(legalMoveRes.actionId, "H9");
  assert.equal(legalMoveRes.gameState, undefined, "move acknowledgements should stay compact");
  assert.equal(legalMoveRes.status, "playing");
  const stateAfterMove = await dispatchGameAction(binding, "get_state", {});
  assert.equal(stateAfterMove.gameState.turn, PLAYER_BLACK);
  assert.equal(stateAfterMove.gameState.board[6][7], PLAYER_WHITE);

  // 5. Agent sends in-game chat
  const chatRes = await dispatchGameAction(binding, "send_chat", {
    message: "这一步走得不错，不过我的白子已经盯紧你了！",
    mood: "confident"
  });
  assert.equal(chatRes.ok, true);
  assert.equal(chatRes.chat.sender, "agent");
  assert.equal(chatRes.chat.message, "这一步走得不错，不过我的白子已经盯紧你了！");
  assert.equal(chatRes.chat.mood, "confident");

  // 6. Test get_history action
  const historyRes = await dispatchGameAction(binding, "get_history", {});
  assert.equal(historyRes.moveHistory.length, 2, "Should have 2 moves in history");
  assert.equal(
    historyRes.chatHistory.length,
    2,
    "Should have make_move reason chat + explicit send_chat"
  );
  assert.equal(
    historyRes.chatHistory[0].message,
    "抢占中路邻近要点",
    "make_move reason should be emitted as an agent chat"
  );

  // Verify lean snapshot in get_state does not contain full moveHistory
  assert.equal(stateRes.gameState.moveHistory, undefined, "Lean snapshot should omit moveHistory");

  // 7. Agent resigns
  const resignRes = await dispatchGameAction(binding, "resign", {
    reason: "局势不妙，甘拜下风"
  });
  assert.equal(resignRes.ok, true);
  assert.equal(resignRes.gameState.status, "player_won");
  assert.equal(resignRes.gameState.winner, PLAYER_BLACK);
});

test("Frontend game scripts (Gomoku & Xiangqi) execute cleanly without runtime reference errors", () => {
  const gameFiles = [
    path.resolve(process.cwd(), "public/games/gomoku/game.js"),
    path.resolve(process.cwd(), "public/games/xiangqi/game.js")
  ];

  for (const filePath of gameFiles) {
    const code = fs.readFileSync(filePath, "utf-8");
    assert.doesNotThrow(() => {
      const mockElement = {
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        removeChild() {},
        getBoundingClientRect() { return { width: 500, height: 600, left: 0, top: 0 }; },
        getContext() {
          return {
            fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
            moveTo() {}, lineTo() {}, closePath() {}, save() {}, restore() {},
            createRadialGradient() { return { addColorStop() {} }; },
            createLinearGradient() { return { addColorStop() {} }; },
            setTransform() {}, scale() {}, fillText() {}, strokeRect() {}, setLineDash() {}
          };
        }
      };
      const mockDoc = {
        getElementById(id) {
          return { ...mockElement, id };
        },
        createElement(tag) {
          return { ...mockElement, tagName: tag };
        },
        body: mockElement
      };
      const windowListeners = {};
      const mockWindow = {
        addEventListener(type, handler) {
          (windowListeners[type] = windowListeners[type] || []).push(handler);
        },
        removeEventListener() {},
        // Mimic the WebIDL receiver check: extracting this method and calling
        // it unbound must throw instead of silently succeeding.
        requestAnimationFrame(cb) {
          if (this !== mockWindow) throw new TypeError("Illegal invocation");
          cb();
          return 1;
        },
        cancelAnimationFrame() {},
        devicePixelRatio: 1,
        innerWidth: 800,
        innerHeight: 700,
        document: mockDoc,
        postMessage() {},
        localStorage: {
          getItem() { return null; },
          setItem() {}
        }
      };
      mockWindow.parent = mockWindow;
      const sandbox = {
        window: mockWindow,
        document: mockDoc,
        console,
        Math,
        Date,
        Array,
        String,
        Number,
        Object,
        Boolean,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval
      };
      vm.createContext(sandbox);
      vm.runInContext(code, sandbox);
      // Route a resize event through the recorded listeners so the
      // requestAnimationFrame scheduling path in debouncedResizeCanvas runs.
      for (const handler of windowListeners.resize || []) {
        handler({ type: "resize" });
      }
    }, `Runtime execution error in ${filePath}`);
  }
});

test("game canvas recovers correct size after hidden-tab zero-size fallback", () => {
  // gomoku: parent rect 500x600 minus 12px gutters -> 488; fallback floor is 460.
  // xiangqi: 9:10 aspect on the same rect -> 488x542; fallback floor is 450x500.
  const scenarios = [
    {
      game: "gomoku",
      file: path.resolve(process.cwd(), "public/games/gomoku/game.js"),
      canvasId: "gomoku-canvas",
      fallback: { width: 460, height: 460 },
      expected: { width: 488, height: 488 }
    },
    {
      game: "xiangqi",
      file: path.resolve(process.cwd(), "public/games/xiangqi/game.js"),
      canvasId: "xiangqi-canvas",
      fallback: { width: 450, height: 500 },
      expected: { width: 488, height: 542 }
    }
  ];

  for (const scenario of scenarios) {
    const code = fs.readFileSync(scenario.file, "utf-8");

    // Mutable layout state the sandboxed script re-reads on every resize pass.
    const layout = {
      containerWidth: 500,
      containerHeight: 600,
      innerWidth: 800,
      innerHeight: 700,
      hidden: false
    };
    const windowListeners = {};
    const documentListeners = {};
    const resizeObservers = [];
    let canvasElement = null;

    const mockElement = {
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      removeEventListener() {},
      appendChild() {},
      removeChild() {},
      getBoundingClientRect() { return { width: 500, height: 600, left: 0, top: 0 }; },
      getContext() {
        return {
          fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
          moveTo() {}, lineTo() {}, closePath() {}, save() {}, restore() {},
          createRadialGradient() { return { addColorStop() {} }; },
          createLinearGradient() { return { addColorStop() {} }; },
          setTransform() {}, scale() {}, fillText() {}, strokeRect() {}, setLineDash() {}
        };
      }
    };
    const mockBody = {
      ...mockElement,
      // resizeCanvas resolves the parent to document.body in this sandbox, so
      // this rect stands in for the .board-wrapper container size.
      getBoundingClientRect() {
        return { width: layout.containerWidth, height: layout.containerHeight, left: 0, top: 0 };
      }
    };
    const mockDoc = {
      getElementById(id) {
        const el = { ...mockElement, id };
        if (id === scenario.canvasId) canvasElement = el;
        return el;
      },
      createElement(tag) {
        return { ...mockElement, tagName: tag };
      },
      body: mockBody,
      addEventListener(type, handler) {
        (documentListeners[type] = documentListeners[type] || []).push(handler);
      },
      removeEventListener() {},
      get hidden() { return layout.hidden; },
      get visibilityState() { return layout.hidden ? "hidden" : "visible"; }
    };
    const mockWindow = {
      addEventListener(type, handler) {
        (windowListeners[type] = windowListeners[type] || []).push(handler);
      },
      removeEventListener() {},
      // Mimic the WebIDL receiver check: extracting this method and calling
      // it unbound must throw instead of silently succeeding.
      requestAnimationFrame(cb) {
        if (this !== mockWindow) throw new TypeError("Illegal invocation");
        cb();
        return 1;
      },
      cancelAnimationFrame() {},
      ResizeObserver: class {
        constructor(callback) {
          this.callback = callback;
          resizeObservers.push(this);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      devicePixelRatio: 1,
      get innerWidth() { return layout.innerWidth; },
      get innerHeight() { return layout.innerHeight; },
      document: mockDoc,
      postMessage() {},
      localStorage: {
        getItem() { return null; },
        setItem() {}
      }
    };
    mockWindow.parent = mockWindow;
    const sandbox = {
      window: mockWindow,
      document: mockDoc,
      console,
      Math,
      Date,
      Array,
      String,
      Number,
      Object,
      Boolean,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: `${scenario.game}.game.js` });

    const dispatchWindow = (type) => {
      for (const handler of windowListeners[type] || []) handler({ type });
    };
    const dispatchDocument = (type) => {
      for (const handler of documentListeners[type] || []) handler({ type });
    };

    // 1. Visible baseline: the script's initial resizeCanvas() applied the
    //    real container size.
    assert.equal(canvasElement.width, scenario.expected.width, `${scenario.game}: baseline canvas.width`);
    assert.equal(canvasElement.height, scenario.expected.height, `${scenario.game}: baseline canvas.height`);

    // 2. Tab hidden: the board container collapses to zero while the window
    //    reports a tiny viewport, so the size falls back and fallbackRetried
    //    latches true.
    layout.containerWidth = 0;
    layout.containerHeight = 0;
    layout.hidden = true;
    layout.innerWidth = 200;
    layout.innerHeight = 100;
    for (const ro of resizeObservers) ro.callback();
    dispatchWindow("resize");
    assert.equal(canvasElement.width, scenario.fallback.width, `${scenario.game}: hidden-tab fallback canvas.width`);
    assert.equal(canvasElement.height, scenario.fallback.height, `${scenario.game}: hidden-tab fallback canvas.height`);

    // 3. Further resizes while still hidden must not loop the fallback retry.
    dispatchWindow("resize");
    dispatchWindow("resize");
    assert.equal(canvasElement.width, scenario.fallback.width, `${scenario.game}: sticky fallback stays put while hidden`);

    // 4. Tab visible again with the real container size back: the
    //    visibilitychange handler must recover the canvas even though
    //    fallbackRetried is still latched from the hidden phase.
    layout.containerWidth = 500;
    layout.containerHeight = 600;
    layout.hidden = false;
    layout.innerWidth = 800;
    layout.innerHeight = 700;
    dispatchDocument("visibilitychange");
    assert.equal(canvasElement.width, scenario.expected.width, `${scenario.game}: recovered canvas.width after visibilitychange`);
    assert.equal(canvasElement.height, scenario.expected.height, `${scenario.game}: recovered canvas.height after visibilitychange`);
    assert.equal(canvasElement.style.width, `${scenario.expected.width}px`, `${scenario.game}: recovered inline width`);

    // 5. A follow-up resize after recovery keeps the recovered size.
    dispatchWindow("resize");
    assert.equal(canvasElement.width, scenario.expected.width, `${scenario.game}: recovered size survives a follow-up resize`);
    assert.equal(canvasElement.height, scenario.expected.height, `${scenario.game}: recovered size survives a follow-up resize`);
  }
});

test("packaged and WebUI game wiring loads the board without a workspace", () => {
  const gameSetup = fs.readFileSync(
    new URL("../src/components/Games/GameSetupModal.tsx", import.meta.url),
    "utf8"
  );
  const canvas = fs.readFileSync(
    new URL("../src/components/Browser/BrowserCanvas.tsx", import.meta.url),
    "utf8"
  );
  const detail = fs.readFileSync(
    new URL("../src/components/CLI/DetailColumn.tsx", import.meta.url),
    "utf8"
  );
  const preload = fs.readFileSync(
    new URL("../public/web-preload.js", import.meta.url),
    "utf8"
  );
  const acpRuntime = fs.readFileSync(
    new URL("../electron/cli/acpRuntime.ts", import.meta.url),
    "utf8"
  );
  const gameService = fs.readFileSync(
    new URL("../electron/gameToolService.ts", import.meta.url),
    "utf8"
  );

  assert.match(gameSetup, /bundledGameEntry\(gamePath\)/);
  assert.doesNotMatch(gameSetup, /window\.location\.href\)\.href/);
  assert.match(canvas, /bundledGameEntry\(gameType\)/);
  assert.match(canvas, /isBundledGameType/);
  assert.match(detail, /conv\?\.kind === "game" \? "preview" : "overview"/);
  assert.match(preload, /invoke\("game:getState"/);
  assert.match(preload, /invoke\("game:playerMove"/);
  assert.match(preload, /invoke\("game:playerResign"/);
  assert.match(preload, /subscribe\("freebuddy:\/\/game-event"/);
  assert.match(acpRuntime, /registerGameToolSession/);
  const gameBlock = acpRuntime.slice(
    acpRuntime.indexOf("const isGameSession"),
    acpRuntime.indexOf("if (args.skills?.length)")
  );
  assert.doesNotMatch(
    gameBlock,
    /remoteIsolated/,
    "WebUI game sessions must still receive the game MCP server"
  );
  assert.match(gameService, /conversationId: conversationId \|\| snapshot\.gameId/);
});

test("Game mode architecture and spectator support in multi-agent and engine modes", () => {
  const protocol = fs.readFileSync(
    new URL("../electron/shared/gameToolProtocol.ts", import.meta.url),
    "utf8"
  );
  const gameService = fs.readFileSync(
    new URL("../electron/gameToolService.ts", import.meta.url),
    "utf8"
  );
  const gameSetup = fs.readFileSync(
    new URL("../src/components/Games/GameSetupModal.tsx", import.meta.url),
    "utf8"
  );
  const canvas = fs.readFileSync(
    new URL("../src/components/Browser/BrowserCanvas.tsx", import.meta.url),
    "utf8"
  );
  const gomoku = fs.readFileSync(
    new URL("../public/games/gomoku/game.js", import.meta.url),
    "utf8"
  );
  const xiangqi = fs.readFileSync(
    new URL("../public/games/xiangqi/game.js", import.meta.url),
    "utf8"
  );

  // Protocol defines the 3 battle modes and participant structures
  assert.match(protocol, /export type GameMode = "player_vs_agent" \| "agent_vs_agent" \| "agent_vs_engine"/);
  assert.match(protocol, /export interface GameParticipant/);
  assert.match(protocol, /gameMode\?: GameMode/);
  assert.match(protocol, /participants\?:/);

  // Game service enriches snapshots and handles spectator playerSide
  assert.match(gameService, /enrichSnapshot/);
  assert.match(gameService, /isSpectator/);
  assert.match(gameService, /gameMode === "agent_vs_engine"/);

  // GameSetupModal defaults to easy (free play) and supports 3 battle modes
  assert.match(gameSetup, /selectedDifficulty.*"easy"/);
  assert.match(gameSetup, /modePlayerVsAgent/);
  assert.match(gameSetup, /modeAgentVsAgent/);
  assert.match(gameSetup, /modeAgentVsEngine/);
  assert.match(gameSetup, /isPlayableGameAgent/);
  // Official-profile members (butler/guide) never play games.
  assert.match(gameSetup, /!m.profile/);

  // BrowserCanvas supports multi-agent and engine turn loops
  assert.match(canvas, /mode === "agent_vs_agent"/);
  assert.match(canvas, /mode === "agent_vs_engine"/);

  // Frontend scripts handle spectator mode and participants
  assert.match(gomoku, /playerSide === 0 \|\| gameMode === "agent_vs_agent"/);
  assert.match(xiangqi, /playerSide === 0 \|\| gameMode === "agent_vs_agent"/);
  assert.match(xiangqi, /isLeftRed\s*=\s*\(gameMode === "agent_vs_agent"/);
});

test("full moveHistory is persisted and completely restored on getState and state sync", async () => {
  const conversationId = `conv-history-test-${Date.now()}`;
  let persistedMetadata = { gameType: "xiangqi", gameDifficulty: "easy" };
  initGamePersistence(
    () => ({ metadata: persistedMetadata }),
    (id, patch) => {
      persistedMetadata = { ...persistedMetadata, ...patch };
    }
  );

  // Step 1: Red moves b2e2
  const m1 = handlePlayerMove(conversationId, "b2e2");
  assert.equal(m1.ok, true);
  assert.equal(m1.gameState.moveHistory.length, 1);

  // Step 2: Black moves b9c7
  const m2 = handleAgentMove(conversationId, "b9c7", "跳马守中卒");
  assert.equal(m2.ok, true);
  assert.equal(m2.gameState.moveHistory.length, 2);

  // Step 3: Red moves h0g2
  const m3 = handlePlayerMove(conversationId, "h0g2");
  assert.equal(m3.ok, true);
  assert.equal(m3.gameState.moveHistory.length, 3);

  // Re-fetch full state as the UI canvas does on refresh/re-mount
  const stateSnapshot = handleGetGameState(conversationId);
  assert.ok(Array.isArray(stateSnapshot.moveHistory));
  assert.equal(stateSnapshot.moveHistory.length, 3, "handleGetGameState must return all 3 moves in moveHistory");
  assert.equal(stateSnapshot.moveHistory[0].actionId, "b2e2");
  assert.equal(stateSnapshot.moveHistory[1].actionId, "b9c7");
  assert.equal(stateSnapshot.moveHistory[2].actionId, "h0g2");

  // Verify DB rehydration from persisted metadata
  const restoredGame = XiangqiGameInstance.fromSnapshot(persistedMetadata.gameState);
  const restoredSnapshot = restoredGame.getSnapshot({ includeHistory: true });
  assert.equal(restoredSnapshot.moveHistory.length, 3, "Rehydrated game from database must retain all 3 moves");
});
