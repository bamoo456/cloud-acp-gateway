// The prebuilt fork (@homebridge/node-pty-prebuilt-multiarch, aliased to
// "node-pty" in package.json) ships its types as an ambient module declared
// under its own package name, so `import ... from "node-pty"` finds no module
// types. Re-export the fork's surface under the "node-pty" specifier so the
// source can keep importing the stable "node-pty" name.
//
// NOTE: fork-specific shim. If main reverts to upstream Microsoft node-pty
// (which ships proper module typings), delete this file. See issue #131.
declare module "node-pty" {
  export * from "@homebridge/node-pty-prebuilt-multiarch";
}
