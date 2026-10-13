const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const create = require("../src/main/file-workflows");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "onegyeok-workflow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entries = new Map([["/", []]]),
    jobs = [],
    events = [];
  let active = true;
  const manager = {
    assertConnected() {
      if (!active) throw Error("disconnected");
    },
    remotePath: (v) => path.posix.resolve("/", v),
    emit: (id, type, data) => events.push({ type, data }),
    localList: async (dir) => ({
      entries: await Promise.all(
        (await fs.readdir(dir)).map(async (name) => {
          const st = await fs.lstat(path.join(dir, name));
          return {
            name,
            directory: st.isDirectory(),
            symlink: st.isSymbolicLink(),
            size: st.size,
            modified: st.mtimeMs,
          };
        }),
      ),
    }),
    list: async (id, dir) => {
      if (!entries.has(dir)) throw Error("missing folder");
      return { entries: entries.get(dir).map((e) => ({ ...e })) };
    },
    operation: async (id, action, target, value) => {
      const rows = entries.get(path.posix.dirname(target));
      if (action === "mkdir") {
        if (rows.some((e) => e.name === path.posix.basename(target)))
          throw Error("exists");
        rows.push({
          name: path.posix.basename(target),
          directory: true,
          size: 0,
        });
        entries.set(target, []);
      } else if (action === "rename") {
        if (rows.some((e) => e.name === path.posix.basename(value)))
          throw Error("exists");
        const entry = rows.find((e) => e.name === path.posix.basename(target));
        if (!entry) throw Error("missing");
        entry.name = path.posix.basename(value);
      }
    },
    enqueue: (id, p) => {
      manager.assertConnected();
      jobs.push(p);
      return String(jobs.length);
    },
  };
  const workflows = create(manager);
  t.after(() => workflows.clear("s"));
  return {
    root,
    entries,
    jobs,
    events,
    workflows,
    stop() {
      active = false;
      workflows.clear("s");
    },
  };
}
test("recursive upload preserves empty folders, excludes symlinks and queues nested files", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "empty"));
  await fs.mkdir(path.join(f.root, "nested"));
  await fs.writeFile(path.join(f.root, "nested", "file"), "data");
  await fs.symlink("/tmp", path.join(f.root, "link"));
  const result = await f.workflows.recursive("s", {
    direction: "upload",
    localPath: f.root,
    remotePath: "/backup",
  });
  assert.equal(result.jobIds.length, 1);
  assert.ok(f.entries.has("/backup/empty"));
  assert.equal(f.jobs[0].remotePath, "/backup/nested/file");
  assert.equal(f.entries.has("/backup/link"), false);
});
test("sync comparison supports size/date criteria and never deletes target-only files", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "same"), "data");
  await fs.writeFile(path.join(f.root, "new"), "new");
  f.entries
    .get("/")
    .push({ name: "same", size: 4, modified: 1 }, { name: "keep", size: 10 });
  const p = await f.workflows.preview("s", {
    direction: "upload",
    localPath: f.root,
    remotePath: "/",
    compare: "size",
  });
  assert.equal(p.items.find((i) => i.relative === "same").status, "same");
  assert.equal(
    p.items.find((i) => i.relative === "keep").status,
    "target-only",
  );
  await f.workflows.execute("s", p.token);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].overwrite, false);
  const q = await f.workflows.preview("s", {
    direction: "upload",
    localPath: f.root,
    remotePath: "/",
  });
  assert.equal(q.items.find((i) => i.relative === "same").status, "changed");
});
test("changed preview is refused before enqueueing", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "file"), "data");
  const p = await f.workflows.preview("s", {
    direction: "upload",
    localPath: f.root,
    remotePath: "/",
  });
  await fs.writeFile(path.join(f.root, "file"), "changed data");
  await assert.rejects(f.workflows.execute("s", p.token), /다시 비교/);
  assert.equal(f.jobs.length, 0);
});
test("symlink destination and file-directory conflicts block sync", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "file"), "data");
  f.entries.get("/").push({ name: "file", symlink: true, size: 4 });
  const p = await f.workflows.preview("s", {
    direction: "upload",
    localPath: f.root,
    remotePath: "/",
  });
  assert.equal(p.items[0].status, "conflict");
  await assert.rejects(f.workflows.execute("s", p.token), /충돌/);
  assert.equal(f.jobs.length, 0);
});
test("recursive download creates local folders and preserves target-only items", async (t) => {
  const f = await fixture(t);
  f.entries.get("/").push({ name: "remote", directory: true });
  f.entries.set("/remote", [
    { name: "empty", directory: true },
    { name: "data", size: 4, modified: 1 },
  ]);
  f.entries.set("/remote/empty", []);
  const result = await f.workflows.recursive("s", {
    direction: "download",
    localPath: path.join(f.root, "download"),
    remotePath: "/remote",
  });
  assert.equal(result.jobIds.length, 1);
  assert.ok(
    (await fs.stat(path.join(f.root, "download", "empty"))).isDirectory(),
  );
  assert.equal(f.jobs[0].localPath, path.join(f.root, "download", "data"));
});
test("batch rename previews literal replacements, prefixes and numbering and applies local changes", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "old.txt"), "data");
  const p = await f.workflows.renamePreview("s", {
    side: "local",
    root: f.root,
    names: ["old.txt"],
    find: "old",
    replace: "new",
    prefix: "pre-",
    number: true,
  });
  assert.equal(p.items[0].to, "pre-new.txt_001");
  assert.equal((await f.workflows.execute("s", p.token)).completed.length, 1);
  assert.equal(
    await fs.readFile(path.join(f.root, "pre-new.txt_001"), "utf8"),
    "data",
  );
  await assert.rejects(f.workflows.execute("s", p.token), /만료/);
});
test("batch rename rejects collisions, duplicate selection and traversal", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "a"), "data");
  await fs.writeFile(path.join(f.root, "b"), "data");
  const base = { side: "local", root: f.root, names: ["a"] };
  await assert.rejects(
    f.workflows.renamePreview("s", { ...base, find: "a", replace: "b" }),
    /충돌/,
  );
  await assert.rejects(
    f.workflows.renamePreview("s", { ...base, prefix: "../" }),
    /유효/,
  );
  await assert.rejects(
    f.workflows.renamePreview("s", { ...base, names: ["a", "a"] }),
    /중복/,
  );
});
test("remote batch rename returns partial completion when a destination appears after preview", async (t) => {
  const f = await fixture(t);
  f.entries.get("/").push({ name: "a", size: 1 }, { name: "b", size: 1 });
  const p = await f.workflows.renamePreview("s", {
    side: "remote",
    root: "/",
    names: ["a", "b"],
    prefix: "new-",
  });
  f.entries.get("/").push({ name: "new-b", size: 1 });
  const result = await f.workflows.execute("s", p.token);
  assert.equal(result.completed.length, 1);
  assert.equal(result.error, "exists");
  assert.equal(result.remaining.length, 1);
});
test("reservation queues at requested time and is removed on cancel or disconnect", async (t) => {
  const f = await fixture(t);
  const p = {
    direction: "upload",
    localPath: path.join(f.root, "file"),
    remotePath: "/file",
    at: Date.now() + 1100,
  };
  f.workflows.reserve("s", p);
  const cancel = f.workflows.reserve("s", { ...p, remotePath: "/cancel" });
  f.workflows.cancelReservation("s", cancel);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(f.jobs.length, 1);
  assert.equal(f.events.at(-1).data[0].status, "queued");
  f.workflows.reserve("s", {
    ...p,
    at: Date.now() + 1100,
    remotePath: "/disconnect",
  });
  f.stop();
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(f.jobs.length, 1);
});
test("invalid reservation times are rejected and execution failures are visible", async (t) => {
  const f = await fixture(t);
  const p = {
    direction: "upload",
    localPath: f.root,
    remotePath: "/missing",
    recursive: true,
  };
  assert.throws(
    () => f.workflows.reserve("s", { ...p, at: Date.now() - 1 }),
    /예약/,
  );
  assert.throws(
    () => f.workflows.reserve("s", { ...p, at: Date.now() + 8 * 86400000 }),
    /예약/,
  );
  f.workflows.reserve("s", {
    ...p,
    direction: "download",
    at: Date.now() + 1100,
  });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(f.events.at(-1).data[0].status, "error");
});

test("disconnect during comparison rejects stale session work", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "file"), "data");
  const pending = f.workflows.preview("s", {
    direction: "upload",
    localPath: f.root,
    remotePath: "/",
  });
  f.stop();
  await assert.rejects(pending, /disconnected|취소/);
  assert.equal(f.jobs.length, 0);
});
