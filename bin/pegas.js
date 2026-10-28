#!/usr/bin/env node

import("../dist/index.js").catch((err) => {
  console.error("Failed to run pegas:", err);
  process.exit(1);
});
