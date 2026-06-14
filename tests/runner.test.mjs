import test from "node:test";
import assert from "node:assert/strict";
import { buildConfinedCommand } from "../dist/runner.js";

const BASE_INPUT = {
	confineBin: "/opt/gits/gits-confine.sh",
	worktree: "/home/joshua/work/peer-abc",
	codexHome: "/home/joshua/.delamain/peer-codex-home",
	egress: "host",
	label: "peer-abc",
	toolchainRootDir: "/home/joshua/.nvm/versions/node/v24.12.0",
	toolchainBinDir: "/home/joshua/.nvm/versions/node/v24.12.0/bin",
	engineCmd: "codex",
	engineArgs: ["exec", "--json", "-C", "/home/joshua/work/peer-abc", "-"],
};

test("buildConfinedCommand uses the confine binary as the command", () => {
	const { command } = buildConfinedCommand(BASE_INPUT);
	assert.equal(command, BASE_INPUT.confineBin);
});

test("buildConfinedCommand puts confine flags before -- and engine argv after", () => {
	const { args } = buildConfinedCommand(BASE_INPUT);
	const sepIndex = args.indexOf("--");
	assert.ok(sepIndex !== -1, "expected a -- separator in the argv");

	const pre = args.slice(0, sepIndex);
	const post = args.slice(sepIndex + 1);

	// engine argv comes immediately after the separator: codex then its args verbatim
	assert.deepEqual(post, [BASE_INPUT.engineCmd, ...BASE_INPUT.engineArgs]);

	// none of the engine args leaked into the confine-flag section
	assert.ok(!pre.includes("--"), "confine section must not contain a separator");
	assert.ok(!pre.includes("codex"), "engine command must not be in the confine section");
});

test("buildConfinedCommand emits the recipe flags with correct values", () => {
	const { args } = buildConfinedCommand(BASE_INPUT);
	const sepIndex = args.indexOf("--");
	const pre = args.slice(0, sepIndex);

	// helper: value that follows a flag
	const valueAfter = (flag) => {
		const i = pre.indexOf(flag);
		return i === -1 ? undefined : pre[i + 1];
	};

	assert.equal(valueAfter("--worktree"), BASE_INPUT.worktree);
	assert.equal(valueAfter("--profile"), "peer");
	assert.equal(valueAfter("--label"), BASE_INPUT.label);
	assert.equal(valueAfter("--egress"), "host");
	assert.equal(valueAfter("--ro"), BASE_INPUT.toolchainRootDir);

	// both creds present (--cred appears twice)
	const creds = pre.filter((a, i) => pre[i - 1] === "--cred");
	assert.deepEqual(creds, [
		`${BASE_INPUT.codexHome}/auth.json`,
		`${BASE_INPUT.codexHome}/config.toml`,
	]);

	// setenv CODEX_HOME and setenv PATH (PATH puts the toolchain bin dir first)
	const setenvs = pre.filter((a, i) => pre[i - 1] === "--setenv");
	assert.ok(setenvs.includes(`CODEX_HOME=${BASE_INPUT.codexHome}`), "CODEX_HOME setenv present");
	assert.ok(
		setenvs.includes(`PATH=${BASE_INPUT.toolchainBinDir}:/usr/local/bin:/usr/bin:/bin`),
		"PATH setenv present with toolchain bin dir first",
	);
});

test("buildConfinedCommand orders confine flags: worktree, profile, label, egress, ro, creds, setenvs", () => {
	const { args } = buildConfinedCommand(BASE_INPUT);
	const sepIndex = args.indexOf("--");
	const pre = args.slice(0, sepIndex);

	assert.deepEqual(pre, [
		"--worktree", BASE_INPUT.worktree,
		"--profile", "peer",
		"--label", BASE_INPUT.label,
		"--egress", "host",
		"--ro", BASE_INPUT.toolchainRootDir,
		"--cred", `${BASE_INPUT.codexHome}/auth.json`,
		"--cred", `${BASE_INPUT.codexHome}/config.toml`,
		"--setenv", `CODEX_HOME=${BASE_INPUT.codexHome}`,
		"--setenv", `PATH=${BASE_INPUT.toolchainBinDir}:/usr/local/bin:/usr/bin:/bin`,
	]);
});

test("buildConfinedCommand honors a non-host egress value", () => {
	const { args } = buildConfinedCommand({ ...BASE_INPUT, egress: "off" });
	const i = args.indexOf("--egress");
	assert.equal(args[i + 1], "off");
});

test("buildConfinedCommand returns raw engine command when confineBin is empty (unconfined passthrough)", () => {
	const { command, args } = buildConfinedCommand({ ...BASE_INPUT, confineBin: "" });
	assert.equal(command, "codex");
	assert.deepEqual(args, [...BASE_INPUT.engineArgs]);
	// the passthrough argv is a copy, not the same reference
	assert.notEqual(args, BASE_INPUT.engineArgs);
});
