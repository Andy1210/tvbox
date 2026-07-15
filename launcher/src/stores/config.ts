// Moved to @tvbox/app-sdk (app-sdk/src/config-store.ts) so app packages share the
// same config store. Re-export shim so the launcher's call sites are unchanged.
export * from "@sdk/config-store";
