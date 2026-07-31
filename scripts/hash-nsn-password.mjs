import { randomBytes, scrypt } from "node:crypto";

const password = process.env.NSN_PASSWORD_TO_HASH ?? process.argv[2] ?? "";

if (password.length < 12) {
  console.error(
    "Provide a password of at least 12 characters through NSN_PASSWORD_TO_HASH or as the first argument.",
  );
  process.exit(1);
}

const N = 16_384;
const r = 8;
const p = 1;
const salt = randomBytes(16);

const derivedKey = await new Promise((resolve, reject) => {
  scrypt(
    password,
    salt,
    64,
    { N, p, r, maxmem: 128 * 1024 * 1024 },
    (error, key) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(key);
    },
  );
});

console.log(
  `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`,
);
