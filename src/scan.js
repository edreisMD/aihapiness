// src/scan.js — discover Claude Code transcript JSONL files on disk and report basic metadata.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Scan the Claude projects directory for transcript JSONL files.
 *
 * @param {{ root?: string, project?: string }} [opts]
 *   root    - base dir of encoded project folders (defaults to ~/.claude/projects)
 *   project - if given, keep only files whose encoded project dir contains this substring
 * @returns {Array<{ sessionId, project, path, mtimeMs, sizeBytes }>}
 *   Sorted newest-first by mtime. Returns [] if root is missing/unreadable.
 */
export function scanTranscripts({ root, project } = {}) {
  const baseRoot = root || path.join(os.homedir(), '.claude', 'projects');
  const results = [];

  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(baseRoot, { withFileTypes: true });
  } catch {
    // Root doesn't exist or isn't readable — nothing to scan.
    return results;
  }

  for (const dirent of projectDirs) {
    let encodedProject;
    try {
      // Be tolerant of plain strings vs Dirent objects across Node versions.
      const name = dirent && dirent.name ? dirent.name : String(dirent);
      const isDir = dirent && typeof dirent.isDirectory === 'function'
        ? dirent.isDirectory()
        : true;
      if (!isDir) continue;
      encodedProject = name;
    } catch {
      continue;
    }

    // Optional project filter: substring match against the encoded project dir.
    if (project && !encodedProject.includes(project)) continue;

    const projectPath = path.join(baseRoot, encodedProject);
    let entries = [];
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      let fileName;
      try {
        fileName = entry && entry.name ? entry.name : String(entry);
        const isFile = entry && typeof entry.isFile === 'function' ? entry.isFile() : true;
        if (!isFile) continue;
      } catch {
        continue;
      }
      if (!fileName.endsWith('.jsonl')) continue;

      const filePath = path.join(projectPath, fileName);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      results.push({
        sessionId: fileName.replace(/\.jsonl$/, ''),
        project: encodedProject,
        path: filePath,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
  }

  // Newest first — most relevant sessions surface at the top.
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}
