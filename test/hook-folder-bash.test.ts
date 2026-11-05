import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CALL, CANT_TELL, followed, hook, refused, root, sent, SUB_PIN } from "./hook-folder-fixture.js";
import { tempDir } from "./tmp.js";

describe("bash: every spelling that can be read is followed (#163)", () => {
  followed("Bash", [
    "cd DIR",
    "cd -- DIR",
    "cd -P DIR",
    "cd -L DIR",
    "cd -LP DIR",
    "cd -Pe DIR",
    "cd -L -- DIR",
    "pushd DIR",
    "pushd -- DIR",
    "builtin cd DIR",
    "command cd DIR",
    'D=DIR; cd "$D"',
    "D=DIR; cd $D",
    'D=DIR; cd "${D}"',
    'export D=DIR; cd "$D"',
    'D=DIR; pushd "$D"',
    'cd "$PWD/DIR"',
    'cd sub; cd "$OLDPWD/DIR"',
    "pushd sub; pushd ../DIR; pushd ../other; popd",
    "cd sub; cd ../DIR",
    "cd DIR/; cd ./",
  ]);

  it.each(['cd "$HOOK_DIR"', "cd $HOOK_DIR", 'cd "${HOOK_DIR}"', 'pushd "$HOOK_DIR"'])("follows %j from the hook's environment (decision 4)", async (shape) => {
    const line = `${shape}; ${CALL}`;
    expect((await hook(line, "Bash", { HOOK_DIR: "sub" })).decision).toBe("deny");
    expect((await hook(line, "Bash", { HOOK_DIR: "other" })).decision).toBe("allow");
  });

  it("a path through the hook's environment joins with what follows", async () => {
    expect((await hook(`cd "$HOOK_DIR/sub"; ${CALL}`, "Bash", { HOOK_DIR: root })).decision).toBe("deny");
    expect((await hook(`cd "$HOOK_DIR/other"; ${CALL}`, "Bash", { HOOK_DIR: root })).decision).toBe("allow");
  });

  it("goes back with cd - and popd to a folder the line knows", async () => {
    expect((await hook(`cd sub; cd -; ${CALL}`)).decision).toBe("allow");
    expect((await hook(`cd sub; cd ../other; cd -; ${CALL}`)).decision).toBe("deny");
    expect((await hook(`pushd sub; popd; ${CALL}`)).decision).toBe("allow");
    expect((await hook(`pushd other; pushd ../sub; popd; ${CALL}`)).decision).toBe("allow");
    expect((await hook(`pushd sub; pushd ../other; popd; ${CALL}`)).decision).toBe("deny");
    expect((await hook(`pushd sub; pushd ../other; pushd; ${CALL}`)).decision).toBe("deny");
    expect((await hook(`pushd other; pushd ../sub; pushd; ${CALL}`)).decision).toBe("allow");
    expect((await hook(`pushd sub; pushd ../other; pushd ../other; popd; popd; ${CALL}`)).decision).toBe("deny");
    expect((await hook(`cd sub; (cd ../other); cd -; ${CALL}`)).decision).toBe("allow");
  });

  it("goes home with a bare cd, and $HOME from the hook's environment", async () => {
    expect((await hook(`cd sub; cd; ${CALL}`, "Bash", { HOME: join(root, "other") })).decision).toBe("allow");
    expect((await hook(`cd; ${CALL}`, "Bash", { HOME: join(root, "sub") })).decision).toBe("deny");
    expect((await hook(`cd ~; ${CALL}`, "Bash", { HOME: join(root, "sub") })).decision).toBe("deny");
    expect((await hook(`cd ~/sub; ${CALL}`, "Bash", { HOME: root })).decision).toBe("deny");
    expect((await hook(`cd "$HOME"; ${CALL}`, "Bash", { HOME: join(root, "sub") })).decision).toBe("deny");
    expect((await hook(`cd ~; ${CALL}`, "Bash", { HOME: join(root, "other") })).decision).toBe("allow");
  });

  it("a command that fails in bash leaves the folder where it was", async () => {
    // cd: -a: invalid option, and so on: real Git Bash stays put, so the call runs where it was.
    for (const line of ["cd -Path sub", "cd -LiteralPath sub", "cd -x sub", "pushd -L sub", "CD sub", "Set-Location sub", "sl sub", "Push-Location sub"]) {
      expect((await hook(`${line}; ${CALL}`)).decision, line).toBe("allow");
    }
  });

  it("a folder with brackets in quotes is a folder, and a space in quotes one word", async () => {
    mkdirSync(join(root, "sub", "[id]"), { recursive: true });
    mkdirSync(join(root, "sub", "a b"), { recursive: true });
    expect((await hook(`cd "sub/[id]"; ${CALL}`)).reason).toContain(SUB_PIN);
    expect((await hook(`cd "sub/a b"; ${CALL}`)).reason).toContain(SUB_PIN);
    expect((await hook(`D="sub/a b"; cd "$D"; ${CALL}`)).reason).toContain(SUB_PIN);
  });
});

describe("bash: what can't be read stops later calls as can't tell (#163)", () => {
  refused("Bash", [
    'cd "$(git rev-parse --show-toplevel)/x"',
    "cd $(git rev-parse --show-toplevel)",
    "cd `git rev-parse --show-toplevel`",
    'cd "$UNSET_DIR"',
    "cd $UNSET_DIR",
    'cd "${UNSET_DIR:-sub}"',
    'cd "$UNSET_DIR/sub"',
    'pushd "$UNSET_DIR"',
    "cd -",
    "cd su*",
    "cd s?b",
    "cd s[u]b",
    'cd "s"*',
    "cd {sub,other}",
    "cd {sub,}",
    'D=sub; cd "$D"/*',
    "D='su*'; cd $D",
    "D='sub other'; cd $D",
    "cd sub other",
    "cd ~nobody",
    'cd "~"',
    'cd ""',
    'D=; cd "$D"',
    "chdir sub",
    "popd",
    "pushd",
    "pushd +1",
    "pushd -2",
    "pushd -n sub",
    "pushd -",
    "popd -n",
    "popd +1",
    "cd -2",
    "cd -@ sub",
    "CDPATH=/elsewhere cd sub",
    "CDPATH=/elsewhere; cd sub",
    'D=$(cat f); cd "$D"',
    'export D=$(cat f); cd "$D"',
    'cd "$(cat f)"; cd sub',
    'cd "$(cat f)"; cd -',
    'pushd "$(cat f)"; popd',
    // With a stack the line knows, and a folder to go back to: it still can't say.
    "pushd other; popd -n",
    "pushd other; popd +1",
    "cd other; pushd -",
    'cd sub; cd "$(cat f)"; cd -',
    'pushd other; pushd "$(cat f)"; popd',
    // A glob beside what a variable gave, where a quote doesn't say which part is text.
    'D=sub; cd "$D"/s[u]b',
  ]);

  it("a variable the line unset or set from a command isn't read from the hook's environment", async () => {
    const env = { D: "other" };
    expect((await hook(`D=$(cat f); cd "$D"; ${CALL}`, "Bash", env)).reason).toContain(CANT_TELL);
    expect((await hook(`unset D; cd "$D"; ${CALL}`, "Bash", env)).reason).toContain(CANT_TELL);
    expect((await hook(`cd "$D"; ${CALL}`, "Bash", env)).decision).toBe("allow");
  });

  it("$CDPATH from the hook's environment makes a bare relative folder unknown, not ./x or an absolute path", async () => {
    const env = { CDPATH: "/elsewhere" };
    expect((await hook(`cd sub; ${CALL}`, "Bash", env)).reason).toContain(CANT_TELL);
    expect((await hook(`cd other; ${CALL}`, "Bash", env)).reason).toContain(CANT_TELL);
    expect((await hook(`cd ./other; ${CALL}`, "Bash", env)).decision).toBe("allow");
    expect((await hook(`cd ./sub; ${CALL}`, "Bash", env)).reason).toContain(SUB_PIN);
    expect((await hook(`cd ${JSON.stringify(join(root, "other"))}; ${CALL}`, "Bash", env)).decision).toBe("allow");
    expect((await hook(`cd sub; ${CALL}`, "Bash", { CDPATH: "" })).reason).toContain(SUB_PIN);
    expect((await hook(`unset CDPATH; cd other; ${CALL}`, "Bash", env)).decision).toBe("allow");
  });

  it("an absolute folder makes it known again; a relative one doesn't", async () => {
    const abs = (dir: string) => JSON.stringify(join(root, dir));
    expect((await hook(`cd "$(cat f)"; cd ${abs("other")}; ${CALL}`)).decision).toBe("allow");
    expect((await hook(`cd "$(cat f)"; cd ${abs("sub")}; ${CALL}`)).reason).toContain(SUB_PIN);
    expect((await hook(`cd "$(cat f)"; cd ${abs("other")}; cd ../sub; ${CALL}`)).reason).toContain(SUB_PIN);
    expect((await hook(`cd "$(cat f)"; pushd ${abs("other")}; popd; ${CALL}`)).reason).toContain(CANT_TELL);
    expect((await hook(`cd "$(cat f)"; cd ${abs("other")}; cd -; ${CALL}`)).reason).toContain(CANT_TELL);
    expect((await hook(`cd "$(cat f)"; cd ${abs("other")}; cd "$OLDPWD/x"; ${CALL}`)).reason).toContain(CANT_TELL);
  });

  it("stops the call even with no pin file in sight: the folder it goes to may have one", async () => {
    const bare = realpathSync(tempDir("cloudpin-163-unpinned-"));
    expect((await hook(CALL, "Bash", {}, bare)).decision).toBe("allow");
    expect((await hook(`cd "$(cat f)"; ${CALL}`, "Bash", {}, bare)).reason).toContain(CANT_TELL);
  });

  it("a call before the folder is lost is checked where it runs; one after asks no CLI", async () => {
    sent.length = 0;
    expect((await hook(`${CALL}; cd "$(cat f)"`)).decision).toBe("allow");
    expect(sent.length).toBeGreaterThan(0);
    sent.length = 0;
    expect((await hook(`cd "$(cat f)"; ${CALL}`)).decision).toBe("deny");
    expect(sent).toEqual([]);
  });

  it("names no value", async () => {
    const env = { SECRET_DIR: "value-from-the-environment" };
    const { reason } = await hook(`cd "\${SECRET_DIR:-x}"; ${CALL}`, "Bash", env);
    expect(reason).toContain(CANT_TELL);
    expect(reason).not.toContain("value-from-the-environment");
  });

  it("a wrapper's folder only known when it runs is unknown too", async () => {
    for (const line of [`env -C "$D" ${CALL}`, `sudo -D "$(cat f)" ${CALL}`, `pnpm -C "$D" exec ${CALL}`, `yarn --cwd "$D" run ${CALL}`]) {
      expect((await hook(line)).reason, line).toContain(CANT_TELL);
    }
    // Glued to its flag it was already can't tell, as a flag the wrapper can't read.
    expect((await hook(`env --chdir="$D" ${CALL}`)).reason).toContain("can't tell");
    // One given a relative folder from a folder it can't read, and an absolute one.
    expect((await hook(`cd "$(cat f)"; env -C sub ${CALL}`)).reason).toContain(CANT_TELL);
    expect((await hook(`cd "$(cat f)"; env -C ${JSON.stringify(join(root, "other"))} ${CALL}`)).decision).toBe("allow");
    // The controls: a literal one is still followed.
    expect((await hook(`env -C sub ${CALL}`)).reason).toContain(SUB_PIN);
    expect((await hook(`env -C other ${CALL}`)).decision).toBe("allow");
  });
});

describe("bash: a subshell or a job keeps its folder to itself (#163)", () => {
  it.each([
    ["(cd sub; CALL)", "deny"],
    ["(cd sub); CALL", "allow"],
    ["(cd sub; (cd ../other; CALL); CALL)", "deny"],
    ["(cd other; (cd ../sub; CALL); CALL)", "deny"],
    ["(cd other; (cd ../sub); CALL)", "allow"],
    ["(pushd sub); popd; CALL", "cant"],
    ["pushd other; (pushd ../sub); popd; CALL", "allow"],
    ["pushd sub; (popd); CALL", "deny"],
    ["cd sub; (cd -); CALL", "deny"],
    ['(cd "$(cat f)"); CALL', "allow"],
    ['(cd "$(cat f)"; CALL)', "cant"],
    ['(cd "$(cat f)"; CALL); CALL', "cant"],
    ["{ cd sub; }; CALL", "deny"],
    ["{ cd other; }; CALL", "allow"],
    ['{ cd "$(cat f)"; }; CALL', "cant"],
    ["x=$(cd sub; pwd); CALL", "allow"],
    ['x=$(cd "$(cat f)"; pwd); CALL', "allow"],
    ["x=$(cd sub; CALL)", "deny"],
    ["bash -c 'cd sub'; CALL", "allow"],
    ["bash -c 'cd sub; CALL'", "deny"],
    ["bash -c 'cd \"$(cat f)\"'; CALL", "allow"],
    ["eval cd sub; CALL", "deny"],
    ["eval 'true | cd sub'; CALL", "allow"],
    ["cd sub | cat; CALL", "allow"],
    ["cd sub & CALL", "allow"],
    ["cd sub && CALL", "deny"],
    ["true && cd sub; CALL", "deny"],
    ["false || cd sub; CALL", "deny"],
    ["true | cd sub; CALL", "allow"],
    ['cd "$(cat f)" | cat; CALL', "allow"],
    ['cd "$(cat f)" & CALL', "allow"],
    ["cd sub |& cat; CALL", "allow"],
    ["cd sub && cd ../other | cat; CALL", "deny"],
    ["if true; then cd sub; fi; CALL", "deny"],
  ])("%j", async (shape, expected) => {
    const { decision, reason } = await hook(shape.split("CALL").join(CALL));
    if (expected === "cant") expect(reason).toContain(CANT_TELL);
    else {
      expect(decision).toBe(expected);
      if (expected === "deny") expect(reason).toContain(SUB_PIN);
    }
  });
});
