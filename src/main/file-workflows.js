"use strict";
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
module.exports = function createWorkflows(manager) {
  const contexts = new Map();
  const context = (id) => {
    manager.assertConnected(id);
    if (!contexts.has(id))
      contexts.set(id, { plans: new Map(), timers: new Map() });
    return contexts.get(id);
  };
  function check(id, c) {
    manager.assertConnected(id);
    if (contexts.get(id) !== c)
      throw Error("이전 연결의 작업이 취소되었습니다");
  }
  function roots(p) {
    if (
      !["upload", "download"].includes(p.direction) ||
      typeof p.localPath !== "string" ||
      !path.isAbsolute(p.localPath)
    )
      throw Error("전송 방향과 로컬 절대 경로가 필요합니다");
    return { ...p, remotePath: manager.remotePath(p.remotePath) };
  }
  async function tree(id, side, root, c) {
    if (side === "local") {
      const st = await fs.lstat(root);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw Error("일반 로컬 폴더만 비교할 수 있습니다");
    }
    const result = new Map();
    let count = 0;
    async function walk(dir, relative, depth) {
      check(id, c);
      if (depth > 64) throw Error("폴더 깊이 제한(64)을 초과했습니다");
      const data =
        side === "local"
          ? await manager.localList(dir)
          : await manager.list(id, dir);
      check(id, c);
      for (const entry of data.entries) {
        if (++count > 10000) throw Error("항목 제한(10,000)을 초과했습니다");
        if (
          !entry.name ||
          entry.name === "." ||
          entry.name === ".." ||
          /[\\/\r\n\0]/.test(entry.name)
        )
          throw Error("안전하지 않은 파일명입니다");
        if (/\.onegyeok-.*\.part$/.test(entry.name)) continue;
        const rel = relative ? relative + "/" + entry.name : entry.name;
        result.set(rel, entry);
        if (entry.directory && !entry.symlink)
          await walk(
            side === "local"
              ? path.join(dir, entry.name)
              : path.posix.join(dir, entry.name),
            rel,
            depth + 1,
          );
      }
    }
    await walk(root, "", 0);
    return result;
  }
  async function preview(id, params) {
    const c = context(id),
      p = roots(params);
    const local = await tree(id, "local", p.localPath, c),
      remote = await tree(id, "remote", p.remotePath, c);
    const source = p.direction === "upload" ? local : remote,
      target = p.direction === "upload" ? remote : local;
    const items = [];
    for (const [relative, a] of source) {
      if (a.symlink) continue;
      const b = target.get(relative);
      let status = b?.symlink
        ? "conflict"
        : !b
          ? "missing"
          : !!a.directory !== !!b.directory
            ? "conflict"
            : a.directory
              ? "same"
              : a.size !== b.size ||
                  (p.compare !== "size" &&
                    Math.abs((a.modified || 0) - (b.modified || 0)) > 2000)
                ? "changed"
                : "same";
      items.push({
        relative,
        directory: a.directory,
        status,
        sourceSize: a.size,
        targetSize: b?.size,
        modified: a.modified,
      });
    }
    for (const [relative, b] of target)
      if (!source.has(relative))
        items.push({ relative, directory: b.directory, status: "target-only" });
    const signature = JSON.stringify([
      Array.from(local).sort((a, b) => a[0].localeCompare(b[0])),
      Array.from(remote).sort((a, b) => a[0].localeCompare(b[0])),
    ]);
    const token = crypto.randomUUID();
    if (c.plans.size >= 20) c.plans.delete(c.plans.keys().next().value);
    const result = { token, kind: "sync", params: p, items };
    c.plans.set(token, { ...result, signature, created: Date.now() });
    return result;
  }
  async function ensureRemote(id, target, c) {
    check(id, c);
    const parent = path.posix.dirname(target);
    const listing = await manager.list(id, parent);
    check(id, c);
    const entry = listing.entries.find(
      (e) => e.name === path.posix.basename(target),
    );
    if (entry) {
      if (!entry.directory || entry.symlink)
        throw Error("폴더 대상 충돌: " + target);
    } else await manager.operation(id, "mkdir", target);
  }
  async function execute(id, token) {
    const c = context(id),
      plan = c.plans.get(token);
    if (!plan || Date.now() - plan.created > 300000)
      throw Error("미리보기가 만료되었습니다");
    c.plans.delete(token);
    if (plan.kind === "rename") return applyRename(id, plan, c);
    const fresh = await preview(id, plan.params);
    check(id, c);
    const current = c.plans.get(fresh.token);
    c.plans.delete(fresh.token);
    if (current.signature !== plan.signature)
      throw Error("파일 목록이 변경되었습니다. 다시 비교해주세요");
    if (plan.items.some((i) => i.status === "conflict"))
      throw Error("파일/폴더 충돌을 먼저 해결해주세요");
    const p = plan.params,
      jobIds = [];
    for (const item of plan.items
      .filter((i) => i.directory && i.status === "missing")
      .sort(
        (a, b) => a.relative.split("/").length - b.relative.split("/").length,
      )) {
      if (p.direction === "upload")
        await ensureRemote(id, path.posix.join(p.remotePath, item.relative), c);
      else {
        check(id, c);
        const destination = path.join(p.localPath, item.relative);
        await fs.mkdir(destination);
      }
    }
    for (const item of plan.items.filter(
      (i) => !i.directory && ["missing", "changed"].includes(i.status),
    )) {
      check(id, c);
      jobIds.push(
        manager.enqueue(id, {
          direction: p.direction,
          localPath: path.join(p.localPath, item.relative),
          remotePath: path.posix.join(p.remotePath, item.relative),
          overwrite: item.status === "changed",
          verify: !!p.verify,
          modified: item.modified,
        }),
      );
    }
    return {
      jobIds,
      directories: plan.items.filter(
        (i) => i.directory && i.status === "missing",
      ).length,
    };
  }
  async function recursive(id, params) {
    const c = context(id),
      p = roots(params);
    if (params.direction === "upload") {
      const st = await fs.lstat(p.localPath);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw Error("일반 폴더만 전송할 수 있습니다");
      check(id, c);
      await ensureRemote(id, p.remotePath, c);
    } else {
      const listing = await manager.list(id, path.posix.dirname(p.remotePath));
      const entry = listing.entries.find(
        (e) => e.name === path.posix.basename(p.remotePath),
      );
      check(id, c);
      if (!entry?.directory || entry.symlink)
        throw Error("일반 폴더만 전송할 수 있습니다");
      try {
        const st = await fs.lstat(p.localPath);
        if (!st.isDirectory() || st.isSymbolicLink())
          throw Error("로컬 폴더 대상 충돌");
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        await fs.mkdir(p.localPath, { recursive: true });
      }
    }
    check(id, c);
    const plan = await preview(id, p);
    check(id, c);
    if (plan.items.some((i) => i.status === "changed")) {
      if (!params.overwrite)
        throw Error("기존 파일 덮어쓰기 확인이 필요합니다");
    }
    return execute(id, plan.token);
  }
  async function renamePreview(id, p) {
    const c = context(id);
    if (
      !["local", "remote"].includes(p.side) ||
      !Array.isArray(p.names) ||
      !p.names.length ||
      p.names.length > 1000
    )
      throw Error("이름변경 항목을 선택해주세요");
    const root =
      p.side === "local" ? path.resolve(p.root) : manager.remotePath(p.root);
    const data =
      p.side === "local"
        ? await manager.localList(root)
        : await manager.list(id, root);
    const existing = new Set(data.entries.map((e) => e.name));
    const items = p.names.map((name, index) => {
      if (new Set(p.names).size !== p.names.length)
        throw Error("선택 항목이 중복되었습니다");
      if (!existing.has(name)) throw Error("항목을 찾을 수 없습니다");
      let next = String(name);
      if (p.find)
        next = next.split(String(p.find)).join(String(p.replace || ""));
      next =
        String(p.prefix || "") +
        next +
        String(p.suffix || "") +
        (p.number ? "_" + String(index + 1).padStart(3, "0") : "");
      if (
        !next ||
        next === "." ||
        next === ".." ||
        /[\\/\r\n\0]/.test(next) ||
        Buffer.byteLength(next) > 255
      )
        throw Error("유효하지 않은 새 이름입니다");
      return { from: name, to: next };
    });
    const targets = new Set();
    for (const item of items) {
      if (
        targets.has(item.to) ||
        (item.to !== item.from && existing.has(item.to))
      )
        throw Error("이름 충돌: " + item.to);
      targets.add(item.to);
    }
    const token = crypto.randomUUID();
    if (c.plans.size >= 20) c.plans.delete(c.plans.keys().next().value);
    c.plans.set(token, {
      kind: "rename",
      side: p.side,
      root,
      items,
      created: Date.now(),
    });
    return { token, kind: "rename", items };
  }
  async function applyRename(id, p, c) {
    const completed = [];
    for (const item of p.items) {
      if (item.from === item.to) continue;
      try {
        check(id, c);
        if (p.side === "remote")
          await manager.operation(
            id,
            "rename",
            path.posix.join(p.root, item.from),
            path.posix.join(p.root, item.to),
          );
        else {
          const data = await manager.localList(p.root);
          check(id, c);
          if (data.entries.some((e) => e.name === item.to))
            throw Error("대상 이름이 존재합니다");
          await fs.rename(
            path.join(p.root, item.from),
            path.join(p.root, item.to),
          );
        }
        completed.push(item);
      } catch (err) {
        return {
          completed,
          error: err.message,
          remaining: p.items.filter((i) => !completed.includes(i)),
        };
      }
    }
    return { completed };
  }
  function notify(id, c) {
    if (contexts.get(id) !== c) return;
    manager.emit(
      id,
      "schedules",
      Array.from(c.timers.values()).map((t) => ({
        id: t.id,
        at: t.at,
        status: t.status,
        error: t.error || null,
      })),
    );
  }
  function reserve(id, p) {
    const c = context(id);
    const delay = Number(p.at) - Date.now();
    if (!Number.isFinite(delay) || delay < 1000 || delay > 7 * 86400000)
      throw Error("예약은 현재부터 1초~7일 사이로 지정해주세요");
    if (c.timers.size >= 20) throw Error("예약은 연결당 최대 20개입니다");
    const params = roots(p);
    const job = {
      id: crypto.randomUUID(),
      at: Number(p.at),
      status: "waiting",
    };
    job.timer = setTimeout(async () => {
      job.status = "running";
      notify(id, c);
      try {
        if (p.recursive) await recursive(id, params);
        else manager.enqueue(id, params);
        job.status = "queued";
      } catch (err) {
        job.status = "error";
        job.error = err.message;
      }
      notify(id, c);
    }, delay);
    c.timers.set(job.id, job);
    notify(id, c);
    return job.id;
  }
  function cancelReservation(id, key) {
    const c = context(id),
      job = c.timers.get(key);
    if (!job || job.status !== "waiting")
      throw Error("대기 중인 예약만 취소할 수 있습니다");
    clearTimeout(job.timer);
    c.timers.delete(key);
    notify(id, c);
  }
  function clear(id) {
    const c = contexts.get(id);
    if (c) for (const t of c.timers.values()) clearTimeout(t.timer);
    contexts.delete(id);
  }
  return {
    preview,
    execute,
    recursive,
    renamePreview,
    reserve,
    cancelReservation,
    clear,
  };
};
