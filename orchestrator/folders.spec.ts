import { test, expect } from "@playwright/test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import {
  checkOwnFolder,
  currentUser,
  describeFolderProblem,
  ownFolderRemedy,
  PRIVATE_FOLDER,
  STATE_FOLDER,
} from "./folders";

/** A fresh folder per test, removed after it. */
let dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-folders-"));
});
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test.describe("checkOwnFolder", () => {
  test("accepts this user's folder closed as the rule asks", async () => {
    const folder = join(dir, "f");
    await mkdir(folder, { mode: 0o700 });
    expect(await checkOwnFolder(folder, PRIVATE_FOLDER)).toEqual({
      kind: "ok",
    });
    await chmod(folder, 0o755);
    // Others may read the state directory, never write in it.
    expect(await checkOwnFolder(folder, STATE_FOLDER)).toEqual({ kind: "ok" });
    expect(await checkOwnFolder(folder, PRIVATE_FOLDER)).toEqual({
      kind: "open",
      mode: 0o755,
    });
  });

  for (const mode of [0o770, 0o707, 0o777, 0o720, 0o702])
    test(`refuses a state directory of mode ${mode.toString(8)}, which others may write in`, async () => {
      const folder = join(dir, "f");
      await mkdir(folder);
      await chmod(folder, mode);
      expect(await checkOwnFolder(folder, STATE_FOLDER)).toEqual({
        kind: "open",
        mode,
      });
    });

  test("refuses another user's folder, whatever its mode", async () => {
    const uid = (process.getuid?.() ?? 0) + 1;
    expect(await checkOwnFolder(dir, PRIVATE_FOLDER, uid)).toEqual({
      kind: "notOwn",
      uid: process.getuid?.() ?? 0,
      mode: 0o700,
    });
  });

  test("checks no owner where the system has no user ids", async () => {
    expect(await checkOwnFolder(dir, PRIVATE_FOLDER, undefined)).toEqual({
      kind: "ok",
    });
  });

  test("refuses a file, and a link unless the rule follows links", async () => {
    const file = join(dir, "file");
    await writeFile(file, "");
    expect(await checkOwnFolder(file, STATE_FOLDER)).toEqual({
      kind: "notFolder",
    });
    const link = join(dir, "link");
    await symlink(dir, link);
    expect(await checkOwnFolder(link, PRIVATE_FOLDER)).toEqual({
      kind: "notFolder",
    });
    expect(await checkOwnFolder(link, STATE_FOLDER)).toEqual({ kind: "ok" });
  });

  test("passes on what the file system throws for nothing there", async () => {
    await expect(
      checkOwnFolder(join(dir, "none"), PRIVATE_FOLDER),
    ).rejects.toThrow(/ENOENT/);
  });
});

test.describe("describeFolderProblem", () => {
  test("says what is wrong, ready to follow the folder's name", () => {
    expect(describeFolderProblem({ kind: "notFolder" })).toBe(
      "is not a folder",
    );
    expect(describeFolderProblem({ kind: "notOwn", uid: 0, mode: 0o700 })).toBe(
      "is owned by uid 0, not this user",
    );
    expect(describeFolderProblem({ kind: "open", mode: 0o777 })).toBe(
      "is mode 777",
    );
  });
});

test.describe("ownFolderRemedy", () => {
  test("closes an open folder as its rule asks", () => {
    expect(
      ownFolderRemedy(
        "/srv/state",
        { kind: "open", mode: 0o777 },
        STATE_FOLDER,
      ),
    ).toBe("chmod go-w /srv/state");
    expect(
      ownFolderRemedy("/srv/t", { kind: "open", mode: 0o755 }, PRIVATE_FOLDER),
    ).toBe("chmod 700 /srv/t");
  });

  test("hands another user's folder to this one with sudo — its owner's chmod is not this user's to run — closing it too only when it is open", () => {
    expect(
      ownFolderRemedy(
        "/srv/state",
        { kind: "notOwn", uid: 0, mode: 0o755 },
        STATE_FOLDER,
        "ci",
      ),
    ).toBe("sudo chown ci /srv/state");
    expect(
      ownFolderRemedy(
        "/srv/t",
        { kind: "notOwn", uid: 0, mode: 0o755 },
        PRIVATE_FOLDER,
        "ci",
      ),
    ).toBe("sudo chown ci /srv/t && chmod 700 /srv/t");
  });

  test("quotes a path or user name the shell would split", () => {
    expect(
      ownFolderRemedy(
        "/srv/my state",
        { kind: "notOwn", uid: 0, mode: 0o700 },
        STATE_FOLDER,
        "o'neil",
      ),
    ).toBe(`sudo chown 'o'\\''neil' '/srv/my state'`);
  });

  test("names this process's user by default", () => {
    expect(
      ownFolderRemedy(
        "/x",
        { kind: "notOwn", uid: 0, mode: 0o700 },
        STATE_FOLDER,
      ),
    ).toBe(`sudo chown ${currentUser()} /x`);
  });
});

test.describe("currentUser", () => {
  test("is the user's name", () => {
    expect(currentUser(() => ({ username: "ci" }), 1001)).toBe("ci");
  });

  test("is the numeric id, which chown takes too, for a user with no name — a container's arbitrary --user", () => {
    const noPasswdEntry = (): never => {
      throw new Error("uv_os_get_passwd returned ENOENT");
    };
    expect(currentUser(noPasswdEntry, 12345)).toBe("12345");
    expect(currentUser(() => ({ username: "" }), 12345)).toBe("12345");
  });

  test("is this system's user by default", () => {
    expect(currentUser()).toBe(userInfo().username);
  });
});
