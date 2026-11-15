"use client";

import { useActivity, type FeedItem } from "@/hooks/useActivity";
import { useChain } from "@/hooks/useChain";
import { usePool } from "@/hooks/usePool";
import { useRealUsers } from "@/hooks/useRealUsers";
import { CHAINS, LINKS } from "@/lib/deployment";
import { fmtUsd } from "@/lib/price";
import { PROOFS } from "@/lib/proofs";
import { Panel, Stat, TxLink } from "./ui";

/**
 * Measured on Base Sepolia by bench/bench.mjs and bench/keeper.mjs (results/SUMMARY.md): an off-chain keeper bot
 * watching the same pool, polling the same public RPC, filled at a median of 10 blocks.
 */
const KEEPER_P50_BLOCKS = 10;

/** The answer strip: one card split by 1px dividers. The lead figure answers "how fast does Parallax act?" */
export function AnswerStrip() {
  const { chain } = useChain();
  const { price, tick } = usePool(chain);
  const { data } = useActivity();
  const { data: users } = useRealUsers();
  const base = data?.stats.base;
  const uni = data?.stats.unichain;

  const cells = [
    <Stat
      key="p50"
      lead
      label="Median trade → execution, Base"
      value={base?.p50Seconds !== undefined ? `${base.p50Seconds.toFixed(1)} s` : "—"}
      sub={base?.n ? `${base.p50Blocks} blocks of 200 ms, over ${base.n} on-chain loops` : "reading the executors…"}
    />,
    <Stat
      key="price"
      label={`mWETH price, ${chain.short}`}
      value={price !== undefined ? `$${fmtUsd(price)}` : "—"}
      sub={tick !== undefined ? <span className="num">tick {tick.toLocaleString("en-US")}</span> : undefined}
    />,
    <Stat key="fast" label="Fastest, Base" value={base?.minSeconds !== undefined ? `${base.minSeconds.toFixed(1)} s` : "—"} sub="block-exact, from the executor" />,
    <Stat
      key="uni"
      label="Median, Unichain"
      value={uni?.p50Seconds !== undefined ? `${uni.p50Seconds.toFixed(0)} s` : "—"}
      sub={uni?.n ? `${uni.p50Blocks} blocks of 1 s, over ${uni.n} loops` : "reading the executors…"}
    />,
    <Stat
      key="users"
      label="Wallets using Parallax"
      value={users ? users.wallets.toLocaleString("en-US") : "—"}
      sub={users ? `${users.ruleOwners} with rules · ${users.depositors} in the vault · deployer excluded` : "counting on-chain…"}
    />,
  ];

  return (
    <section aria-label="Headline figures" className="rounded-[6px] bg-panel shadow-[0_12px_28px_rgba(0,0,0,.2)]">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[6px] bg-line sm:grid-cols-3 xl:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
        {cells.map((c, i) => (
          <div key={i} className={i === 0 ? "col-span-2 bg-panel px-6 py-5 sm:col-span-3 xl:col-span-1" : "bg-panel px-6 py-5"}>
            {c}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Parallax's own element: the latest loop drawn on one axis of origin-chain blocks.
 * ① the swap that crossed the line (block 0) → ② Reactive's tx on Lasna (by its timestamp) → ③ the callback that
 * executed. The hollow tick is where the measured keeper-bot median would have landed.
 */
export function LoopStrip() {
  const { data } = useActivity();
  const live = data?.items.find((x) => x.state === "executed" && x.latencyBlocks !== undefined);
  const it = live ?? storedLatest(); // the newest stored loop until a live one is readable

  return (
    <Panel
      title="Latest loop"
      aside={it ? <span className="num text-[12px] text-faint">{CHAINS[it.chain].name} · rule #{it.ruleId.toString()}</span> : undefined}
    >
      {!it ? (
        <p className="text-[13px] text-muted">No execution yet. Arm a rule below, then crash the price with Demo controls.</p>
      ) : (
        <Strip it={it} />
      )}
    </Panel>
  );
}

/** The newest loop stored by `npm run snapshot`, shaped like a feed row. */
function storedLatest(): FeedItem | undefined {
  const e = [...PROOFS.executions].sort((a, b) => b.t1 - a.t1)[0];
  if (!e) return undefined;
  const c = CHAINS[e.chain];
  return {
    key: `stored:${e.chain}:${e.ruleId}`,
    chain: e.chain,
    ruleId: BigInt(e.ruleId),
    state: "executed",
    originTx: e.originTx,
    originBlock: e.originBlock,
    t0: e.t0,
    reactiveTx: e.reactiveTx ?? undefined,
    callbackTx: e.callbackTx ?? undefined,
    executedBlock: e.executedBlock,
    t1: e.t1,
    latencyBlocks: e.latencyBlocks,
    latencySeconds: (e.latencyBlocks * c.blockMs) / 1000,
  };
}

function Strip({ it }: { it: FeedItem }) {
  const c = CHAINS[it.chain];
  const n = it.latencyBlocks!;
  const span = Math.max(n, KEEPER_P50_BLOCKS) + 2; // axis: block 0 … a little past the later of the two
  const x = (b: number) => `${(b / span) * 100}%`;
  const reactBlocks =
    it.reactiveAt !== undefined && it.t0 !== undefined ? Math.min(Math.max(((it.reactiveAt - it.t0) * 1000) / c.blockMs, 0), n) : undefined;
  const ticks = Array.from({ length: Math.floor(span / 2) + 1 }, (_, i) => i * 2).filter((t) => t <= span);

  return (
    <div>
      <p className="text-[14px] text-ink">
        Executed <span className="num">{n}</span> blocks after the swap that crossed the line,{" "}
        <span className="num">≈ {((n * c.blockMs) / 1000).toFixed(1)} s</span>
        {n < KEEPER_P50_BLOCKS ? (
          <span className="text-muted">
            , <span className="num">{KEEPER_P50_BLOCKS - n}</span> blocks before the measured keeper-bot median.
          </span>
        ) : (
          <span className="text-muted">; the measured keeper-bot median is {KEEPER_P50_BLOCKS} blocks.</span>
        )}
      </p>

      <div className="relative mt-8 h-[84px]" role="img" aria-label={`Swap at block 0, callback at block ${n}`}>
        {/* the track */}
        <div className="absolute inset-x-0 top-[22px] h-[2px] bg-raised" />
        <div className="absolute left-0 top-[22px] h-[2px] bg-ink" style={{ width: x(n) }} />
        {/* keeper-bot median: hollow tick */}
        <div className="absolute top-[14px] h-[18px] w-px bg-control" style={{ left: x(KEEPER_P50_BLOCKS) }} />
        <span className="absolute top-[62px] -translate-x-1/2 whitespace-nowrap text-[12px] text-muted" style={{ left: x(KEEPER_P50_BLOCKS) }}>
          keeper bot, median
        </span>
        {/* stations */}
        <Station at={x(0)} label="① swap" align="start" />
        {reactBlocks !== undefined && <Station at={x(reactBlocks)} label="② Lasna" hollow />}
        <Station at={x(n)} label={`③ executed`} strong />
        {/* block ticks */}
        <div className="absolute inset-x-0 top-[44px]">
          {ticks.map((t) => (
            <span key={t} className="num absolute -translate-x-1/2 text-[11px] text-faint" style={{ left: x(t) }}>
              {t}
            </span>
          ))}
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-1 gap-y-2 text-[13px] sm:grid-cols-3">
        <Row k="① Origin swap" v={<TxLink href={c.explorerTx(it.originTx)} hash={it.originTx} />} sub={it.originBlock ? `block ${it.originBlock.toLocaleString("en-US")}` : undefined} />
        <Row k="② Reactive tx, Lasna" v={<TxLink href={it.reactiveTx ? LINKS.lasnaTx(it.reactiveTx) : "#"} hash={it.reactiveTx} />} />
        <Row k="③ Callback" v={<TxLink href={it.callbackTx ? c.explorerTx(it.callbackTx) : "#"} hash={it.callbackTx} />} sub={it.executedBlock ? `block ${it.executedBlock.toLocaleString("en-US")}` : undefined} />
      </dl>
    </div>
  );
}

function Station({ at, label, strong, hollow, align }: { at: string; label: string; strong?: boolean; hollow?: boolean; align?: "start" }) {
  return (
    <>
      <span
        className={
          hollow
            ? "absolute top-[17px] h-3 w-3 -translate-x-1/2 rounded-full bg-panel ring-2 ring-inset ring-active"
            : strong
              ? "absolute top-[16px] h-[14px] w-[14px] -translate-x-1/2 rounded-full bg-active"
              : "absolute top-[18px] h-[10px] w-[10px] -translate-x-1/2 rounded-full bg-ink"
        }
        style={{ left: at }}
      />
      <span className={align === "start" ? "absolute top-[-6px] whitespace-nowrap text-[12px] text-muted" : "absolute top-[-6px] -translate-x-1/2 whitespace-nowrap text-[12px] text-muted"} style={{ left: at }}>
        {label}
      </span>
    </>
  );
}

function Row({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 sm:block">
      <dt className="text-faint">{k}</dt>
      <dd className="mt-0.5 flex items-baseline gap-2">
        {v}
        {sub && <span className="num text-faint">{sub}</span>}
      </dd>
    </div>
  );
}
