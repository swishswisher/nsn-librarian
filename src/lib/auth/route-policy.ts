const signedBridgeDevicePrefix = "/api/bridge/cloud/devices/";
const pairingRedeemPath = "/api/bridge/cloud/pairing-codes/redeem";
const bridgeReleaseManifestPath = "/api/download/bridge/manifest";

export function isSignedBridgeDevicePath(pathname: string) {
  return pathname.startsWith(signedBridgeDevicePrefix);
}

export function isBridgePairingRedeemPath(pathname: string) {
  return pathname === pairingRedeemPath;
}

export function isBridgeReleaseManifestPath(pathname: string) {
  return pathname === bridgeReleaseManifestPath;
}

export function isPublicAuthPath(pathname: string) {
  return pathname === "/login" || pathname.startsWith("/api/auth/");
}

export function isPublicMachinePath(pathname: string) {
  return (
    isSignedBridgeDevicePath(pathname) ||
    isBridgePairingRedeemPath(pathname) ||
    isBridgeReleaseManifestPath(pathname)
  );
}

export function isHumanApiPath(pathname: string) {
  return pathname.startsWith("/api/") && !isPublicAuthPath(pathname) && !isPublicMachinePath(pathname);
}

export function methodCanChangeState(method: string) {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}
