import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next build` and `next dev` both write to `.next`, and a build run while
  // a dev server is up leaves that server unable to find its own Turbopack
  // runtime — every route then 500s with no application stack trace, which
  // reads exactly like a code bug and is not one.
  //
  // Setting NEXT_DIST_DIR sends a build somewhere else, so the gate can be
  // run without taking down a dev server somebody is using.
  //
  //   NEXT_DIST_DIR=.next-build npm run build
  distDir: process.env.NEXT_DIST_DIR || ".next",

  turbopack: {
    // Pinned explicitly. There is a stray package-lock.json in the user's home
    // directory, and with multiple lockfiles in the ancestry Turbopack inferred
    // C:\Users\Student as the workspace root — which would scope module
    // resolution and file watching to the entire home folder.
    root: path.resolve(import.meta.dirname),
  },
};

export default nextConfig;
