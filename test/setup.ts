import { afterAll } from "vitest";
import { removeTempDirs } from "./tmp.js";

// Tests must not leave folders behind in the system temp directory.
afterAll(removeTempDirs);
