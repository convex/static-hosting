#!/usr/bin/env node
/**
 * CLI for Convex Static Hosting
 *
 * Commands:
 *   deploy              One-shot deployment (Convex backend + static files)
 *   upload              Upload static files to Convex storage
 *   init                Print setup instructions
 */

const command = process.argv[2];

async function main() {
  switch (command) {
    case "setup":
      await import("./setup.js");
      break;

    case "deploy":
      // Pass remaining args to deploy command
      process.argv.splice(2, 1);
      await import("./deploy.js");
      break;

    case "upload":
      // Pass remaining args to upload command
      process.argv.splice(2, 1);
      await import("./upload.js");
      break;

    case "init":
      printInitInstructions();
      break;

    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log("");
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
Convex Static Hosting CLI

Usage:
  npx @convex-dev/static-hosting <command> [options]

Commands:
  setup               Configure the component and add a deploy script
  deploy              One-shot deployment (Convex backend + static files)
  upload              Upload static files to Convex storage
  init                Print setup instructions for integration

Examples:
  # Quick setup (recommended for first-time users)
  npx @convex-dev/static-hosting setup

  # One-shot deployment
  npx @convex-dev/static-hosting deploy

  # Upload only (no Convex backend deploy)
  npx @convex-dev/static-hosting upload --build --prod

Run '<command> --help' for more information on a specific command.
`);
}

function printInitInstructions() {
  console.log(`
📦 Convex Static Hosting

Quick Start:
  npx @convex-dev/static-hosting setup    # Configure files and scripts

For LLMs:
  Read INTEGRATION.md in this package for complete integration instructions

Manual Setup:
  See README.md at https://github.com/convex/static-hosting#readme

This component hosts your static files in Convex storage and serves them via HTTP actions.
`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
