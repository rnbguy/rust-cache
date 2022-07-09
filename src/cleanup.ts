import * as core from "@actions/core";
import * as io from "@actions/io";
import fs from "fs";
import path from "path";
import { CacheConfig, STATE_BINS } from "./config";

import { Packages } from "./workspace";

export async function cleanTargetDir(targetDir: string, packages: Packages) {
  let dir: fs.Dir;
  // remove all *files* from the profile directory
  dir = await fs.promises.opendir(targetDir);
  for await (const dirent of dir) {
    if (dirent.isDirectory()) {
      let dirName = path.join(dir.path, dirent.name);
      // is it a profile dir, or a nested target dir?
      let isNestedTarget =
        (await exists(path.join(dirName, "CACHEDIR.TAG"))) || (await exists(path.join(dirName, ".rustc_info.json")));

      try {
        if (isNestedTarget) {
          await cleanTargetDir(dirName, packages);
        } else {
          await cleanProfileTarget(dirName, packages);
        }
      } catch {}
    } else if (dirent.name !== "CACHEDIR.TAG") {
      await rm(dir.path, dirent);
    }
  }
}

async function cleanProfileTarget(profileDir: string, packages: Packages) {
  await io.rmRF(path.join(profileDir, "examples"));
  await io.rmRF(path.join(profileDir, "incremental"));

  let dir: fs.Dir;
  // remove all *files* from the profile directory
  dir = await fs.promises.opendir(profileDir);
  for await (const dirent of dir) {
    if (dirent.isFile()) {
      await rm(dir.path, dirent);
    }
  }

  const keepPkg = new Set(packages.map((p) => p.name));
  await rmExcept(path.join(profileDir, "build"), keepPkg);
  await rmExcept(path.join(profileDir, ".fingerprint"), keepPkg);

  const keepDeps = new Set(
    packages.flatMap((p) => {
      const names = [];
      for (const n of [p.name, ...p.targets]) {
        const name = n.replace(/-/g, "_");
        names.push(name, `lib${name}`);
      }
      return names;
    }),
  );
  await rmExcept(path.join(profileDir, "deps"), keepDeps);
}

export async function cleanBin(config: CacheConfig) {
  const bins = await config.getCargoBins();
  const oldBins = JSON.parse(core.getState(STATE_BINS));

  for (const bin of oldBins) {
    bins.delete(bin);
  }

  const dir = await fs.promises.opendir(path.join(config.cargoHome, "bin"));
  for await (const dirent of dir) {
    if (dirent.isFile() && !bins.has(dirent.name)) {
      await rm(dir.path, dirent);
    }
  }
}

export async function cleanRegistry(config: CacheConfig, registryName: string, packages: Packages) {
  await io.rmRF(path.join(config.cargoIndex, registryName, ".cache"));

  const pkgSet = new Set(packages.map((p) => `${p.name}-${p.version}.crate`));

  const dir = await fs.promises.opendir(path.join(config.cargoCache, registryName));
  for await (const dirent of dir) {
    if (dirent.isFile() && !pkgSet.has(dirent.name)) {
      await rm(dir.path, dirent);
    }
  }
}

export async function cleanGit(config: CacheConfig, packages: Packages) {
  const coPath = path.join(config.cargoGit, "checkouts");
  const dbPath = path.join(config.cargoGit, "db");
  const repos = new Map<string, Set<string>>();
  for (const p of packages) {
    if (!p.path.startsWith(coPath)) {
      continue;
    }
    const [repo, ref] = p.path.slice(coPath.length + 1).split(path.sep);
    const refs = repos.get(repo);
    if (refs) {
      refs.add(ref);
    } else {
      repos.set(repo, new Set([ref]));
    }
  }

  // we have to keep both the clone, and the checkout, removing either will
  // trigger a rebuild

  let dir: fs.Dir;
  // clean the db
  dir = await fs.promises.opendir(dbPath);
  for await (const dirent of dir) {
    if (!repos.has(dirent.name)) {
      await rm(dir.path, dirent);
    }
  }

  // clean the checkouts
  dir = await fs.promises.opendir(coPath);
  for await (const dirent of dir) {
    const refs = repos.get(dirent.name);
    if (!refs) {
      await rm(dir.path, dirent);
      continue;
    }
    if (!dirent.isDirectory()) {
      continue;
    }
    const refsDir = await fs.promises.opendir(path.join(dir.path, dirent.name));
    for await (const dirent of refsDir) {
      if (!refs.has(dirent.name)) {
        await rm(refsDir.path, dirent);
      }
    }
  }
}

const ONE_WEEK = 7 * 24 * 3600 * 1000;

export async function rmExcept(dirName: string, keepPrefix: Set<string>) {
  const dir = await fs.promises.opendir(dirName);
  for await (const dirent of dir) {
    let name = dirent.name;
    const idx = name.lastIndexOf("-");
    if (idx !== -1) {
      name = name.slice(0, idx);
    }
    const fileName = path.join(dir.path, dirent.name);
    const { mtime } = await fs.promises.stat(fileName);
    // we don’t really know
    if (!keepPrefix.has(name) || Date.now() - mtime.getTime() > ONE_WEEK) {
      await rm(dir.path, dirent);
    }
  }
}

export async function rm(parent: string, dirent: fs.Dirent) {
  try {
    const fileName = path.join(parent, dirent.name);
    core.debug(`deleting "${fileName}"`);
    if (dirent.isFile()) {
      await fs.promises.unlink(fileName);
    } else if (dirent.isDirectory()) {
      await io.rmRF(fileName);
    }
  } catch {}
}

async function exists(path: string) {
  try {
    await fs.promises.access(path);
    return true;
  } catch {
    return false;
  }
}