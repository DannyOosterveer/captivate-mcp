#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CaptivateClient } from "./client.js";

const userId = process.env.CAPTIVATE_USER_ID;
const apiToken = process.env.CAPTIVATE_API_TOKEN;
if (!userId || !apiToken) {
  console.error(
    "Missing credentials: set CAPTIVATE_USER_ID and CAPTIVATE_API_TOKEN (Captivate dashboard → My Account → API).",
  );
  process.exit(1);
}

const captivate = new CaptivateClient(userId, apiToken);

const server = new McpServer({ name: "captivate", version: "0.1.0" });

type Episode = Record<string, unknown> & { id: string; title?: string; published_date?: string };

// Fields kept when listing episodes; full records (show notes, transcripts) come from get_episode.
const EPISODE_SUMMARY_FIELDS = [
  "id",
  "title",
  "status",
  "published_date",
  "episode_number",
  "episode_season",
  "episode_type",
  "episode_private",
  "slug",
] as const;

type Point = { timestamp: number; total: number };

// Buckets start at midnight in the requested timezone, so format them in that timezone ("2026-10-01" or "2026-10-01 13:00").
const localDate = (ms: number, timeZone: string) =>
  new Date(ms)
    .toLocaleString("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .replace(" 00:00", "");
const timeSeries = (points: Point[] = [], timeZone: string) =>
  points.map(({ timestamp, total }) => ({ date: localDate(timestamp, timeZone), total }));
const byTotal = <T extends { total: number }>(items: T[] = []) => [...items].sort((a, b) => b.total - a.total);

async function episodeTitles(showId: string): Promise<Map<string, string>> {
  const res = await captivate.request<{ episodes?: Episode[] }>("GET", `/shows/${showId}/episodes`);
  return new Map((res.episodes ?? []).map((ep) => [ep.id, ep.title ?? ""]));
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
  }
}

const showId = z.string().describe("Captivate show ID (from list_shows)");
const episodeId = z.string().describe("Captivate episode ID (from list_episodes)");
const date = (what: string) =>
  z.string().describe(`${what} date, ISO 8601 (e.g. 2026-01-31 or 2026-01-31T00:00:00Z)`);

// --- Shows & episodes ---------------------------------------------------------------

server.registerTool(
  "list_shows",
  {
    title: "List shows",
    description: "List all podcasts (shows) the authenticated Captivate user has access to.",
    annotations: { readOnlyHint: true },
  },
  () =>
    run(async () => {
      const res = await captivate.request<{ shows?: Record<string, unknown>[] }>("GET", `/users/${userId}/shows`);
      return (res.shows ?? []).map(({ id, title, author, status, created, artwork }) => ({
        id,
        title,
        author,
        status,
        created,
        artwork,
      }));
    }),
);

server.registerTool(
  "get_show",
  {
    title: "Get show",
    description: "Full details of one show, including its RSS feed URL.",
    inputSchema: { show_id: showId },
    annotations: { readOnlyHint: true },
  },
  ({ show_id }) =>
    run(async () => {
      const [show, feed] = await Promise.all([
        captivate.request<{ show?: unknown }>("GET", `/shows/${show_id}`),
        captivate.request<{ feed?: string }>("GET", `/shows/${show_id}/feed`).catch(() => ({ feed: undefined })),
      ]);
      return { ...(show.show as object), feed_url: feed.feed };
    }),
);

server.registerTool(
  "list_episodes",
  {
    title: "List episodes",
    description:
      "List the episodes of a show (newest first) with id, title, status, publish date and episode/season number. " +
      "Use get_episode for show notes and transcripts.",
    inputSchema: {
      show_id: showId,
      scheduled_only: z.boolean().optional().describe("Only return scheduled (not yet published) episodes"),
      search: z.string().optional().describe("Case-insensitive filter on the episode title"),
      limit: z.number().int().positive().optional().describe("Maximum number of episodes to return"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, scheduled_only, search, limit }) =>
    run(async () => {
      const path = scheduled_only ? `/shows/${show_id}/episodes/scheduled` : `/shows/${show_id}/episodes`;
      const res = await captivate.request<{ count?: number; episodes?: Episode[] }>("GET", path);
      let episodes = (res.episodes ?? [])
        .map((ep) => Object.fromEntries(EPISODE_SUMMARY_FIELDS.filter((f) => f in ep).map((f) => [f, ep[f]])))
        .sort((a, b) => String(b.published_date ?? "").localeCompare(String(a.published_date ?? "")));
      if (search) {
        const needle = search.toLowerCase();
        episodes = episodes.filter((ep) => String(ep.title ?? "").toLowerCase().includes(needle));
      }
      return { total: res.count ?? episodes.length, returned: limit ? Math.min(limit, episodes.length) : episodes.length, episodes: limit ? episodes.slice(0, limit) : episodes };
    }),
);

server.registerTool(
  "get_episode",
  {
    title: "Get episode",
    description: "Full details of one episode: show notes, media URL, transcript fields, SEO fields, etc.",
    inputSchema: { episode_id: episodeId },
    annotations: { readOnlyHint: true },
  },
  ({ episode_id }) =>
    run(async () => (await captivate.request<{ episode?: unknown }>("GET", `/episodes/${episode_id}`)).episode),
);

// --- Analytics ------------------------------------------------------------------------

server.registerTool(
  "get_overview_analytics",
  {
    title: "Overview analytics",
    description:
      "Downloads for a show (with its top episodes in that period) or for a single episode over a date range.",
    inputSchema: {
      show_id: showId,
      episode_id: episodeId.optional().describe("Limit to one episode"),
      start: date("Start"),
      end: date("End"),
      top_episodes: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Show-level only: how many top episodes to include, ranked by downloads in the period (default 10)"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, episode_id, start, end, top_episodes }) =>
    run(async () => {
      const res = await captivate.request<Record<string, unknown>>(
        "GET",
        `/insights/${show_id}/overview${episode_id ? `/${episode_id}` : ""}`,
        { query: { start, end } },
      );
      const limit = top_episodes ?? 10;
      if (episode_id || limit === 0) return res;

      // The overview endpoint's own top_episodes carry a "downloads" figure that doesn't match the
      // period's totals, so rank episodes with the range endpoint instead.
      const [range, titles] = await Promise.all([
        captivate.request<{ byEpisode?: { episodeId: string; total: number }[] }>(
          "POST",
          `/insights/${show_id}/range`,
          { body: { start, end, interval: "1d", timezone: "UTC", countryCode: null, types: ["byEpisode"] } },
        ),
        episodeTitles(show_id),
      ]);
      return {
        ...res,
        top_episodes: byTotal(range.byEpisode)
          .slice(0, limit)
          .map(({ episodeId, total }) => ({ id: episodeId, title: titles.get(episodeId), downloads: total })),
      };
    }),
);

server.registerTool(
  "get_total_downloads",
  {
    title: "All-time downloads",
    description: "All-time total downloads for a show, or for a single episode.",
    inputSchema: { show_id: showId, episode_id: episodeId.optional() },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, episode_id }) =>
    run(() => captivate.request("GET", `/insights/${show_id}/total${episode_id ? `/${episode_id}` : ""}`)),
);

server.registerTool(
  "get_monthly_downloads",
  {
    title: "Monthly downloads",
    description: "Downloads per month over the past 12 months for a show, or for a single episode.",
    inputSchema: { show_id: showId, episode_id: episodeId.optional() },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, episode_id }) =>
    run(async () => {
      const res = await captivate.request<{ past_12_months?: { x: string; y: number }[] }>(
        "GET",
        `/insights/${show_id}/monthly${episode_id ? `/${episode_id}` : ""}`,
      );
      return (res.past_12_months ?? []).map(({ x, y }) => ({ month: x, downloads: y }));
    }),
);

server.registerTool(
  "get_average_downloads",
  {
    title: "Average downloads",
    description: "Average downloads per interval (e.g. per 28 days) over the life of the show.",
    inputSchema: {
      show_id: showId,
      interval_days: z.number().int().positive().optional().describe("Interval length in days (default 28)"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, interval_days }) =>
    run(() => captivate.request("GET", `/insights/${show_id}/averages`, { query: { intervalDays: interval_days ?? 28 } })),
);

const BREAKDOWNS = [
  "byLocation",
  "byUserAgentBrowser",
  "byUserAgentOs",
  "byUserAgentDevice",
  "byEpisode",
  "byPrivateSubscriber",
] as const;

server.registerTool(
  "get_range_analytics",
  {
    title: "Analytics for a date range",
    description:
      "Detailed analytics for a show or episode in a date range: downloads over time plus breakdowns by " +
      "country, listening app/browser, OS, device, episode and private subscriber.",
    inputSchema: {
      show_id: showId,
      episode_id: episodeId.optional().describe("Limit to one episode"),
      start: date("Start"),
      end: date("End"),
      interval: z.string().optional().describe("Bucket size for the time series, e.g. 1d, 7d, 1M (default 1d)"),
      timezone: z.string().optional().describe("IANA timezone, e.g. Europe/Amsterdam (default UTC)"),
      country_code: z.string().optional().describe("Filter to one country (ISO 3166-1 alpha-2, e.g. NL)"),
      breakdowns: z
        .array(z.enum(BREAKDOWNS))
        .optional()
        .describe("Which breakdowns to include (default: all; byEpisode only applies to shows)"),
      breakdown_time_series: z
        .boolean()
        .optional()
        .describe("Also return the time series per breakdown item (default false: totals only, much smaller)"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, episode_id, start, end, interval, timezone, country_code, breakdowns, breakdown_time_series }) =>
    run(async () => {
      const tz = timezone ?? "UTC";
      const types = breakdowns ?? BREAKDOWNS.filter((b) => !(episode_id && b === "byEpisode"));
      const res = await captivate.request<Record<string, any>>(
        "POST",
        `/insights/${show_id}/range${episode_id ? `/${episode_id}` : ""}`,
        {
          body: {
            start,
            end,
            interval: interval ?? "1d",
            timezone: tz,
            countryCode: country_code ?? null,
            types,
          },
        },
      );
      const titles = res.byEpisode?.length ? await episodeTitles(show_id) : undefined;
      const breakdown = (items: (Record<string, any> & { total: number; overTime?: Point[] })[] = []) =>
        byTotal(items).map(({ overTime, ...item }) => ({
          ...item,
          ...(titles && item.episodeId ? { title: titles.get(item.episodeId) } : {}),
          ...(breakdown_time_series ? { overTime: timeSeries(overTime, tz) } : {}),
        }));

      return {
        total: res.total,
        uniqueTotal: res.uniqueTotal,
        totalOverTime: timeSeries(res.totalOverTime, tz),
        totalUniqueOverTime: timeSeries(res.totalUniqueOverTime, tz),
        ...(res.byEpisode ? { byEpisode: breakdown(res.byEpisode) } : {}),
        ...(res.byLocation
          ? {
              byLocation: Object.fromEntries(
                Object.entries(res.byLocation as Record<string, any[]>)
                  .filter(([, v]) => v.length)
                  .map(([k, v]) => [k, breakdown(v)]),
              ),
            }
          : {}),
        ...Object.fromEntries(
          ["byUserAgentBrowser", "byUserAgentOs", "byUserAgentDevice", "byPrivateSubscriber"]
            .filter((k) => res[k])
            .map((k) => [k, breakdown(res[k])]),
        ),
      };
    }),
);

server.registerTool(
  "compare_episodes",
  {
    title: "Compare episodes",
    description: "Compare download performance of several episodes of the same show (aligned from each publish date).",
    inputSchema: {
      show_id: showId,
      episode_ids: z.array(z.string()).min(2).describe("Two or more episode IDs to compare"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, episode_ids }) =>
    run(async () => {
      const episodes = await Promise.all(
        episode_ids.map(async (id) => {
          const { episode } = await captivate.request<{ episode: Episode }>("GET", `/episodes/${id}`);
          return { id, title: episode.title, published_date: episode.published_date };
        }),
      );
      const res = await captivate.request<{ label: string; data: { x: number; y: number }[] }[]>(
        "POST",
        `/insights/${show_id}/compare`,
        { body: episodes },
      );
      return {
        note: "cumulative_downloads[n] = total downloads n days after publishing",
        episodes: res.map(({ label, data }) => ({
          title: label,
          published_date: episodes.find((ep) => ep.title === label)?.published_date,
          cumulative_downloads: data.map((p) => p.y),
        })),
      };
    }),
);

server.registerTool(
  "get_web_player_analytics",
  {
    title: "Web player analytics",
    description:
      "Listening behaviour in Captivate's web player for one episode: listeners, seconds listened, " +
      "average % listened and drop-off per position.",
    inputSchema: {
      show_id: showId,
      episode_id: episodeId,
      start: date("Start"),
      end: date("End"),
      duration_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Episode duration in seconds (looked up from the episode's media when omitted)"),
      timezone: z.string().optional().describe("IANA timezone (default UTC)"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, episode_id, start, end, duration_seconds, timezone }) =>
    run(async () => {
      let duration = duration_seconds;
      if (!duration) {
        const { episode } = await captivate.request<{ episode: Episode }>("GET", `/episodes/${episode_id}`);
        if (!episode.media_id) throw new Error("Episode has no media attached; pass duration_seconds.");
        const { media } = await captivate.request<{ media: { media_duration?: number } }>(
          "GET",
          `/media/${episode.media_id}`,
        );
        duration = Math.round(Number(media.media_duration));
        if (!duration) throw new Error("Could not determine the episode duration; pass duration_seconds.");
      }
      const res = await captivate.request<Record<string, any> & { averageCoverage?: Record<string, number> }>(
        "POST",
        `/insights/${show_id}/web-player/${episode_id}`,
        { body: { dateRange: { gte: start, lte: end }, duration: String(duration), timezone: timezone ?? "UTC" } },
      );
      // Coverage maps are keyed per 10 seconds; keep the average, resampled to every 5% of the episode.
      const { averageCoverage, totalCoverage, ...rest } = res;
      const seconds = Object.keys(averageCoverage ?? {}).map(Number);
      const coverageAt = (s: number) =>
        averageCoverage?.[String(seconds.reduce((best, k) => (Math.abs(k - s) < Math.abs(best - s) ? k : best), 0))];
      return {
        ...rest,
        duration_seconds: duration,
        coverage_by_percent: seconds.length
          ? Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`${i * 5}%`, coverageAt((duration! * i) / 20)]))
          : undefined,
      };
    }),
);

await server.connect(new StdioServerTransport());
