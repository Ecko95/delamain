import { Box, Text, createCliRenderer } from "@opentui/core";

const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  exitOnCtrlC: false,
  targetFps: 30,
  consoleMode: "disabled",
});

renderer.root.add(
  Box(
    { id: "base", width: "100%", height: "100%", flexDirection: "column", backgroundColor: "#101820" },
    Text({ content: "BASEBASEBASE ".repeat(20) }),
    Text({ content: "BASEBASEBASE ".repeat(20) }),
    Text({ content: "BASEBASEBASE ".repeat(20) }),
    Text({ content: "BASEBASEBASE ".repeat(20) }),
    Text({ content: "BASEBASEBASE ".repeat(20) }),
    Text({ content: "BASEBASEBASE ".repeat(20) }),
    Text({ content: "BASEBASEBASE ".repeat(20) }),
    Text({ content: "BASEBASEBASE ".repeat(20) }),
  ),
);

renderer.root.add(
  Box(
    {
      id: "popup",
      position: "absolute",
      zIndex: 100,
      left: 20,
      top: 8,
      width: 50,
      height: 12,
      borderStyle: "double",
      backgroundColor: "#050403",
      title: " POPUP ON TOP ",
    },
    Text({ content: "POPUP-CONTENT-LINE" }),
    Text({ content: "POPUP-CONTENT-LINE" }),
  ),
);

if (process.env.SMOKE === "1") {
  await renderer.idle();
  renderer.destroy();
} else {
  await new Promise<void>(() => {});
}
