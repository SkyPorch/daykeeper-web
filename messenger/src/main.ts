import { install } from "./api.ts";

// IIFE entry for the hosted bundle: replace the snippet stub and replay it.
install(window as Parameters<typeof install>[0]);
