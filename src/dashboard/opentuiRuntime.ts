type OpenTuiCore = typeof import("@opentui/core");

export async function runOpenTuiCompatibilitySmoke(): Promise<void> {
  const opentui = (await import("@opentui/core")) as OpenTuiCore;
  const renderer = await opentui.createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    targetFps: 30,
    consoleMode: "disabled",
  });

  try {
    renderer.root.add(
      opentui.Box(
        {
          border: true,
          borderStyle: "single",
          padding: 1,
          width: "100%",
          height: "100%",
          flexDirection: "column",
        },
        opentui.Text({ content: "codex-peers OpenTUI smoke" }),
      ),
    );
    renderer.requestRender();
    await renderer.idle();
  } finally {
    renderer.destroy();
  }
}
