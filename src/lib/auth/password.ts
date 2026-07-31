import { scrypt, timingSafeEqual } from "node:crypto";

const expectedAlgorithm = "scrypt";
const expectedKeyLength = 64;

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; p: number; r: number },
) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      {
        N: options.N,
        p: options.p,
        r: options.r,
        maxmem: 128 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}

export async function verifyNsnPassword(password: string, encodedHash: string) {
  const [algorithm, nValue, rValue, pValue, saltValue, hashValue] =
    encodedHash.split("$");
  const N = Number(nValue);
  const r = Number(rValue);
  const p = Number(pValue);

  if (
    algorithm !== expectedAlgorithm ||
    !Number.isInteger(N) ||
    N < 16_384 ||
    N > 262_144 ||
    !Number.isInteger(r) ||
    r < 8 ||
    r > 32 ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 4 ||
    !saltValue ||
    !hashValue
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(hashValue, "base64url");

    if (salt.length < 16 || expected.length !== expectedKeyLength) {
      return false;
    }

    const actual = await deriveKey(password, salt, expected.length, { N, p, r });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
