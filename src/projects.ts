import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireLock, releaseLock } from "./locks.js";

export type ProjectMeta = {
  project_id: string;
  description: string;
  stack: string[];
  created_at: string;
  updated_at: string;
};

type ProjectsStore = {
  version: 1;
  updated_at: string;
  active_project_id: string | null;
  projects: Record<string, ProjectMeta>;
};

function isoNow() {
  return new Date().toISOString();
}

function projectsDir(syncDir: string) {
  return path.join(syncDir, "projects");
}

function projectsFile(syncDir: string) {
  return path.join(projectsDir(syncDir), "projects.json");
}

function projectDir(syncDir: string, projectId: string) {
  return path.join(projectsDir(syncDir), projectId);
}

function contextFile(syncDir: string, projectId: string) {
  return path.join(projectDir(syncDir, projectId), "context.json");
}

function roadmapFile(syncDir: string, projectId: string) {
  return path.join(projectDir(syncDir, projectId), "roadmap.json");
}

function constraintsFile(syncDir: string, projectId: string) {
  return path.join(projectDir(syncDir, projectId), "constraints.json");
}

function locksDir(syncDir: string) {
  return path.join(syncDir, "queue", "locks");
}

async function ensureProjectsStore(syncDir: string) {
  await fs.mkdir(projectsDir(syncDir), { recursive: true });
  const file = projectsFile(syncDir);
  try {
    await fs.stat(file);
  } catch {
    const init: ProjectsStore = {
      version: 1,
      updated_at: isoNow(),
      active_project_id: null,
      projects: {},
    };
    await fs.writeFile(file, JSON.stringify(init, null, 2), "utf8");
  }
}

async function loadProjectsStore(syncDir: string): Promise<ProjectsStore> {
  await ensureProjectsStore(syncDir);
  const raw = await fs.readFile(projectsFile(syncDir), "utf8");
  const parsed = JSON.parse(raw) as Partial<ProjectsStore>;
  return {
    version: 1,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : isoNow(),
    active_project_id:
      typeof parsed.active_project_id === "string" ? parsed.active_project_id : null,
    projects: parsed.projects ?? {},
  };
}

async function saveProjectsStore(syncDir: string, store: ProjectsStore) {
  const file = projectsFile(syncDir);
  const tmp = `${file}.tmp`;
  store.updated_at = isoNow();
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function ensureProjectFiles(syncDir: string, projectId: string) {
  const dir = projectDir(syncDir, projectId);
  await fs.mkdir(dir, { recursive: true });

  const contextPath = contextFile(syncDir, projectId);
  const roadmapPath = roadmapFile(syncDir, projectId);
  const constraintsPath = constraintsFile(syncDir, projectId);

  try { await fs.stat(contextPath); } catch { await fs.writeFile(contextPath, "{}\n", "utf8"); }
  try { await fs.stat(roadmapPath); } catch { await fs.writeFile(roadmapPath, "{\"items\":[]}\n", "utf8"); }
  try { await fs.stat(constraintsPath); } catch { await fs.writeFile(constraintsPath, "{\"items\":[]}\n", "utf8"); }
}

async function withProjectsLock<T>(syncDir: string, handler: (store: ProjectsStore) => Promise<T>): Promise<T> {
  const lock = await acquireLock({
    locksDir: locksDir(syncDir),
    name: "projects_store",
    ttl_ms: 10_000,
  });
  if (!lock.ok || !lock.token) throw new Error("projects lock busy");

  try {
    const store = await loadProjectsStore(syncDir);
    const result = await handler(store);
    await saveProjectsStore(syncDir, store);
    return result;
  } finally {
    await releaseLock({
      locksDir: locksDir(syncDir),
      name: "projects_store",
      token: lock.token,
    });
  }
}

function validateProjectId(projectId: string) {
  const id = projectId.trim();
  if (!id) throw new Error("project_id is required");
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error("project_id supports only letters, numbers, ., _, -");
  }
  return id;
}

async function readJsonOrEmpty(filePath: string): Promise<any> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function projectCreate(opts: {
  syncDir: string;
  project_id: string;
  description?: string;
  stack?: string[];
}): Promise<{ project: ProjectMeta; active_project_id: string }> {
  const projectId = validateProjectId(opts.project_id);

  return withProjectsLock(opts.syncDir, async (store) => {
    const now = isoNow();
    const existing = store.projects[projectId];
    const project: ProjectMeta = {
      project_id: projectId,
      description: opts.description ?? existing?.description ?? "",
      stack: opts.stack ?? existing?.stack ?? [],
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    store.projects[projectId] = project;
    if (!store.active_project_id) store.active_project_id = projectId;
    await ensureProjectFiles(opts.syncDir, projectId);
    return { project, active_project_id: store.active_project_id };
  });
}

export async function projectList(opts: {
  syncDir: string;
}): Promise<{ active_project_id: string | null; items: ProjectMeta[] }> {
  const store = await loadProjectsStore(opts.syncDir);
  const items = Object.values(store.projects).sort(
    (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
  );
  return { active_project_id: store.active_project_id, items };
}

export async function projectSwitch(opts: {
  syncDir: string;
  project_id: string;
}): Promise<{ active_project_id: string; project: ProjectMeta }> {
  const projectId = validateProjectId(opts.project_id);
  return withProjectsLock(opts.syncDir, async (store) => {
    const project = store.projects[projectId];
    if (!project) throw new Error(`project not found: ${projectId}`);
    store.active_project_id = projectId;
    return { active_project_id: projectId, project };
  });
}

export async function projectContextSet(opts: {
  syncDir: string;
  project_id?: string;
  context?: any;
  roadmap?: any;
  constraints?: any;
}): Promise<{ project_id: string; context: any; roadmap: any; constraints: any }> {
  return withProjectsLock(opts.syncDir, async (store) => {
    const projectId = opts.project_id ? validateProjectId(opts.project_id) : store.active_project_id;
    if (!projectId) throw new Error("active project is not set");
    if (!store.projects[projectId]) throw new Error(`project not found: ${projectId}`);

    await ensureProjectFiles(opts.syncDir, projectId);

    if (opts.context !== undefined) {
      await fs.writeFile(contextFile(opts.syncDir, projectId), JSON.stringify(opts.context ?? {}, null, 2), "utf8");
    }
    if (opts.roadmap !== undefined) {
      await fs.writeFile(roadmapFile(opts.syncDir, projectId), JSON.stringify(opts.roadmap ?? {}, null, 2), "utf8");
    }
    if (opts.constraints !== undefined) {
      await fs.writeFile(
        constraintsFile(opts.syncDir, projectId),
        JSON.stringify(opts.constraints ?? {}, null, 2),
        "utf8"
      );
    }

    const meta = store.projects[projectId];
    meta.updated_at = isoNow();
    store.projects[projectId] = meta;

    return {
      project_id: projectId,
      context: await readJsonOrEmpty(contextFile(opts.syncDir, projectId)),
      roadmap: await readJsonOrEmpty(roadmapFile(opts.syncDir, projectId)),
      constraints: await readJsonOrEmpty(constraintsFile(opts.syncDir, projectId)),
    };
  });
}

export async function projectContextGet(opts: {
  syncDir: string;
  project_id?: string;
}): Promise<{
  project_id: string;
  active_project_id: string | null;
  meta: ProjectMeta;
  context: any;
  roadmap: any;
  constraints: any;
}> {
  const store = await loadProjectsStore(opts.syncDir);
  const projectId = opts.project_id ? validateProjectId(opts.project_id) : store.active_project_id;
  if (!projectId) throw new Error("active project is not set");
  const meta = store.projects[projectId];
  if (!meta) throw new Error(`project not found: ${projectId}`);

  await ensureProjectFiles(opts.syncDir, projectId);
  return {
    project_id: projectId,
    active_project_id: store.active_project_id,
    meta,
    context: await readJsonOrEmpty(contextFile(opts.syncDir, projectId)),
    roadmap: await readJsonOrEmpty(roadmapFile(opts.syncDir, projectId)),
    constraints: await readJsonOrEmpty(constraintsFile(opts.syncDir, projectId)),
  };
}
