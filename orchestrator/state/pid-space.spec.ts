import { test, expect } from "@playwright/test";

import { BOOT_ID_PATH } from "../runs/leader";
import {
  describeSpace,
  earlierBoot,
  INIT_PID_NAMESPACE,
  MACHINE_ID_PATH,
  PID_NAMESPACE_PATH,
  readPidSpace,
  sameSpace,
  type PidSpace,
  type PidSpaceDeps,
} from "./pid-space";

const BOOT = "f6fb3842-61ea-4a8e-8577-4be12500a66e";
const OTHER_BOOT = "0e1d2c3b-4a59-6877-8695-a4b3c2d1e0f9";
const MACHINE = "0123456789abcdef0123456789abcdef";

/** A Linux space; `overrides` changes parts of it. */
function linux(overrides: Partial<PidSpace> = {}): PidSpace {
  return {
    platform: "linux",
    host: "box",
    boot: BOOT,
    pidns: "pid:[4026532829]",
    machine: null,
    ...overrides,
  };
}

/**
 * A system whose files and links hold `files`; any other path fails `ENOENT`.
 *
 * @param platform - the platform.
 * @param files - path → content.
 */
function system(
  platform: NodeJS.Platform,
  files: Record<string, string>,
): PidSpaceDeps {
  const get = (path: string): Promise<string> => {
    const value = files[path];
    return value === undefined
      ? Promise.reject(Object.assign(new Error(path), { code: "ENOENT" }))
      : Promise.resolve(value);
  };
  return { platform, hostname: () => "box\n", readText: get, readLink: get };
}

test.describe("readPidSpace", () => {
  test("reads Linux's boot, PID namespace and machine id, trimmed", async () => {
    expect(
      await readPidSpace(
        system("linux", {
          [BOOT_ID_PATH]: `${BOOT}\n`,
          [PID_NAMESPACE_PATH]: "pid:[4026532829]",
          [MACHINE_ID_PATH]: `${MACHINE}\n`,
        }),
      ),
    ).toEqual(linux({ machine: MACHINE }));
  });

  test("leaves out what cannot be read, or is not what Linux writes, as null", async () => {
    expect(
      await readPidSpace(
        system("linux", {
          [BOOT_ID_PATH]: "not a boot id",
          [PID_NAMESPACE_PATH]: "net:[4026531840]",
        }),
      ),
    ).toEqual(linux({ boot: null, pidns: null }));
  });

  test("names the space by the host alone off Linux, reading no Linux file", async () => {
    expect(await readPidSpace(system("darwin", {}))).toEqual({
      platform: "darwin",
      host: "box",
      boot: null,
      pidns: null,
      machine: null,
    });
  });

  test("never rejects: a host name that throws or holds a control character is null", async () => {
    const deps = system("darwin", {});
    expect(
      (
        await readPidSpace({
          ...deps,
          hostname: () => {
            throw new Error("no host");
          },
        })
      ).host,
    ).toBeNull();
    expect(
      (await readPidSpace({ ...deps, hostname: () => "a\u0007b" })).host,
    ).toBeNull();
  });

  test("reads this system's space", async () => {
    const space = await readPidSpace();
    expect(space.platform).toBe(process.platform);
    if (process.platform === "linux") {
      expect(space.boot).not.toBeNull();
      expect(space.pidns).not.toBeNull();
    } else expect(space.host).not.toBeNull();
  });
});

test.describe("sameSpace", () => {
  test("is the same Linux boot and PID namespace, whatever the host name or machine id", () => {
    expect(sameSpace(linux(), linux({ host: "other", machine: MACHINE }))).toBe(
      true,
    );
  });

  test("is not another PID namespace: two containers both PID 1", () => {
    expect(sameSpace(linux(), linux({ pidns: "pid:[4026532965]" }))).toBe(
      false,
    );
  });

  test("is not another boot", () => {
    expect(sameSpace(linux(), linux({ boot: OTHER_BOOT }))).toBe(false);
  });

  test("is never a space with an unknown part, even against itself", () => {
    expect(sameSpace(linux({ boot: null }), linux({ boot: null }))).toBe(false);
    expect(sameSpace(linux({ pidns: null }), linux({ pidns: null }))).toBe(
      false,
    );
    const mac: PidSpace = { ...linux(), platform: "darwin", host: null };
    expect(sameSpace(mac, mac)).toBe(false);
  });

  test("is the same host name off Linux, and never across platforms", () => {
    const mac: PidSpace = {
      platform: "darwin",
      host: "mac",
      boot: null,
      pidns: null,
      machine: null,
    };
    expect(sameSpace(mac, { ...mac })).toBe(true);
    expect(sameSpace(mac, { ...mac, host: "other" })).toBe(false);
    expect(sameSpace(mac, linux({ host: "mac" }))).toBe(false);
  });
});

test.describe("earlierBoot", () => {
  const host = linux({ pidns: INIT_PID_NAMESPACE, machine: MACHINE });

  test("is an earlier boot of this machine's initial namespace", () => {
    expect(earlierBoot({ ...host, boot: OTHER_BOOT }, host)).toBe(true);
  });

  test("is not the same boot, which is judged by its PID", () => {
    expect(earlierBoot(host, host)).toBe(false);
  });

  for (const [why, earlier, now] of [
    ["another machine", { machine: "f".repeat(32) }, {}],
    ["no machine id", { machine: null }, { machine: null }],
    ["a container's namespace", { pidns: "pid:[4026532829]" }, {}],
    ["this process in a container", {}, { pidns: "pid:[4026532829]" }],
    ["an unknown boot", { boot: null }, {}],
  ] as const)
    test(`is not ${why}`, () => {
      expect(
        earlierBoot(
          { ...host, boot: OTHER_BOOT, ...earlier },
          { ...host, ...now },
        ),
      ).toBe(false);
    });
});

test.describe("describeSpace", () => {
  test("names a Linux boot and namespace, or a host", () => {
    expect(describeSpace(linux())).toBe(`linux boot ${BOOT}, pid:[4026532829]`);
    expect(describeSpace(linux({ boot: null, pidns: null }))).toBe(
      "linux boot unknown, unknown PID namespace",
    );
    expect(describeSpace({ ...linux(), platform: "darwin", host: "mac" })).toBe(
      "darwin host mac",
    );
  });
});
