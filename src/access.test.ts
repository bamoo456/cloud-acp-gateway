import { test } from "node:test";
import assert from "node:assert/strict";
import type os from "node:os";
import { accessUrls } from "./access.ts";

const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
  en0: [
    {
      address: "192.168.3.214",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: "192.168.3.214/24",
    },
    {
      address: "fe80::1",
      netmask: "ffff:ffff:ffff:ffff::",
      family: "IPv6",
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: "fe80::1/64",
      scopeid: 4,
    },
  ],
  lo0: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
};

test("accessUrls expands wildcard binds to local IPv4 URLs", () => {
  assert.deepEqual(
    accessUrls({
      listen: "0.0.0.0:8080",
      path: "/acp",
      scheme: "https",
      interfaces,
    }),
    ["https://127.0.0.1:8080/acp", "https://192.168.3.214:8080/acp"],
  );
});

test("accessUrls keeps explicit binds scoped to that host", () => {
  assert.deepEqual(
    accessUrls({
      listen: "127.0.0.1:9000",
      path: "/",
      scheme: "http",
      interfaces,
    }),
    ["http://127.0.0.1:9000/"],
  );
});
