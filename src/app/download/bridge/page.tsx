import { headers } from "next/headers";
import Link from "next/link";

import { NsnBadge } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { getBridgeReleaseManifest } from "@/lib/bridge/release-manifest";
import {
  suggestedMacArchitecture,
  type BridgeReleaseAsset,
} from "../../../../packages/bridge-protocol/src";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatReleaseDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
  }).format(new Date(value));
}

function formatSize(value: number | null) {
  if (value === null) {
    return "Pending";
  }

  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }

  return `${Math.round(value / (1024 * 1024))} MB`;
}

function DownloadAction({
  asset,
  suggested,
}: {
  asset: BridgeReleaseAsset | undefined;
  suggested: boolean;
}) {
  const label =
    asset?.architecture === "x64"
      ? "Download for Intel Mac"
      : "Download for Apple Silicon";
  const className = [
    "inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border px-4 text-center text-sm font-semibold transition sm:w-fit",
    suggested
      ? "border-[var(--nsn-teal)] bg-[var(--nsn-teal)] text-[var(--nsn-white)]"
      : "border-[var(--nsn-border)] bg-[var(--nsn-card)] text-[var(--nsn-navy)]",
    asset?.available && asset.url
      ? "hover:opacity-90"
      : "cursor-not-allowed opacity-60",
  ].join(" ");

  if (!asset?.available || !asset.url) {
    return (
      <span aria-disabled="true" className={className}>
        {label} — pending
      </span>
    );
  }

  return (
    <a className={className} href={asset.url} rel="noreferrer">
      {label}
    </a>
  );
}

export default async function BridgeDownloadPage() {
  const manifest = await getBridgeReleaseManifest();
  const requestHeaders = await headers();
  const suggested = suggestedMacArchitecture(
    requestHeaders.get("user-agent") ?? "",
  );
  const macAssets = manifest.assets.filter((asset) => asset.kind === "dmg");
  const armAsset = macAssets.find((asset) => asset.architecture === "arm64");
  const intelAsset = macAssets.find((asset) => asset.architecture === "x64");

  return (
    <main className="min-h-screen bg-[var(--nsn-cream)] px-4 py-8 text-[var(--nsn-navy)] sm:px-6 lg:px-8">
      <div className="mx-auto grid w-full max-w-5xl gap-8">
        <header className="grid min-w-0 gap-5 rounded-xl border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-wrap gap-2">
            <NsnBadge tone="approved">Mac companion app</NsnBadge>
            <NsnBadge tone="pending">Unsigned internal build</NsnBadge>
          </div>
          <div className="grid min-w-0 gap-3">
            <h1 className="nsn-display break-words text-4xl leading-tight [overflow-wrap:anywhere] sm:text-5xl">
              NSN Bridge for Mac
            </h1>
            <p className="max-w-3xl break-words text-base leading-8 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              The Bridge lets the Librarian work with folders Deanne explicitly
              chooses on this Mac. It scans, watches, and carries out only
              approved Organization Plans.
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap">
            <DownloadAction
              asset={armAsset}
              suggested={suggested === "arm64"}
            />
            <DownloadAction
              asset={intelAsset}
              suggested={suggested === "x64"}
            />
          </div>
          <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            This is an unsigned internal-testing build because the project does
            not yet use Apple&apos;s paid Developer ID program. Download it only
            from this NSN page. The checksum below lets you verify the file.
          </p>
        </header>

        <section aria-labelledby="release-assets" className="grid min-w-0 gap-4">
          <h2
            className="nsn-display break-words text-3xl [overflow-wrap:anywhere]"
            id="release-assets"
          >
            Downloads
          </h2>
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            {macAssets.map((asset) => (
              <NsnCard className="grid min-w-0 gap-3" key={asset.fileName}>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="break-words font-semibold [overflow-wrap:anywhere]">
                    {asset.architecture === "arm64"
                      ? "Apple Silicon"
                      : "Intel Mac"}
                  </h3>
                  <NsnBadge tone={asset.available ? "approved" : "pending"}>
                    {asset.available ? "Available" : "Pending release"}
                  </NsnBadge>
                </div>
                <dl className="grid min-w-0 gap-2 text-sm leading-6 text-[var(--nsn-slate)]">
                  <div className="min-w-0">
                    <dt className="font-semibold text-[var(--nsn-navy)]">File</dt>
                    <dd className="break-words [overflow-wrap:anywhere]">
                      {asset.fileName}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-[var(--nsn-navy)]">Version</dt>
                    <dd>{manifest.version}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-[var(--nsn-navy)]">Release date</dt>
                    <dd>{formatReleaseDate(manifest.releaseDate)}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-[var(--nsn-navy)]">Size</dt>
                    <dd>{formatSize(asset.sizeBytes)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="font-semibold text-[var(--nsn-navy)]">SHA-256</dt>
                    <dd className="break-words font-mono text-xs [overflow-wrap:anywhere]">
                      {asset.sha256}
                    </dd>
                  </div>
                </dl>
              </NsnCard>
            ))}
          </div>
        </section>

        <section className="grid min-w-0 gap-4 md:grid-cols-2">
          <NsnCard className="grid min-w-0 gap-3">
            <h2 className="nsn-display text-2xl">Installation</h2>
            <ol className="grid min-w-0 gap-2 text-sm leading-7 text-[var(--nsn-slate)]">
              <li>1. Download the build matching this Mac.</li>
              <li>2. Open the DMG and drag NSN Bridge into Applications.</li>
              <li>3. Try to open NSN Bridge once.</li>
              <li>
                4. If macOS blocks it, open System Settings → Privacy &amp;
                Security and choose Open Anyway.
              </li>
              <li>5. Return to NSN Bridge and choose Pair This Mac.</li>
              <li>6. Enter the short-lived code shown by NSN Librarian.</li>
              <li>7. Choose only the folders the Bridge may help with.</li>
            </ol>
          </NsnCard>

          <NsnCard className="grid min-w-0 gap-3">
            <h2 className="nsn-display text-2xl">Privacy</h2>
            <ul className="grid min-w-0 gap-2 text-sm leading-7 text-[var(--nsn-slate)]">
              {manifest.privacySummary.map((item) => (
                <li className="break-words [overflow-wrap:anywhere]" key={item}>
                  {item}
                </li>
              ))}
            </ul>
          </NsnCard>
        </section>

        <section className="grid min-w-0 gap-4 md:grid-cols-2">
          <NsnCard className="grid min-w-0 gap-3">
            <h2 className="nsn-display text-2xl">System Requirements</h2>
            <ul className="grid min-w-0 gap-2 text-sm leading-7 text-[var(--nsn-slate)]">
              {manifest.systemRequirements.map((item) => (
                <li className="break-words [overflow-wrap:anywhere]" key={item}>
                  {item}
                </li>
              ))}
            </ul>
          </NsnCard>

          <NsnCard className="grid min-w-0 gap-3">
            <h2 className="nsn-display text-2xl">Troubleshooting</h2>
            <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              If folder access is lost, open the Bridge and choose the folder
              again through Finder. The Librarian never guesses a local path.
            </p>
            <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              If the website says the Bridge is offline, open NSN Bridge from
              Applications and confirm that the Connection section says paired
              and ready.
            </p>
          </NsnCard>
        </section>

        <NsnCard className="grid min-w-0 gap-3">
          <h2 className="nsn-display text-2xl">Release Notes</h2>
          <ul className="grid min-w-0 gap-2 text-sm leading-7 text-[var(--nsn-slate)]">
            {manifest.releaseNotes.map((item) => (
              <li className="break-words [overflow-wrap:anywhere]" key={item}>
                {item}
              </li>
            ))}
          </ul>
        </NsnCard>

        <Link
          className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] sm:w-fit"
          href="/connect-this-mac"
        >
          Connect This Mac
        </Link>
      </div>
    </main>
  );
}
