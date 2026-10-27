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
      "Downloads and unique listeners for a show (optionally with its top episodes) or a single episode over a date range.",
    inputSchema: {
      show_id: showId,
      episode_id: episodeId.optional().describe("Limit to one episode"),
      start: date("Start"),
      end: date("End"),
      include_top_episodes: z.boolean().optional().describe("Show-level only: include the top episodes (default true)"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, episode_id, start, end, include_top_episodes }) =>
    run(() =>
      captivate.request("GET", `/insights/${show_id}/overview${episode_id ? `/${episode_id}` : ""}`, {
        query: { start, end, includeTopEpisodes: episode_id ? undefined : (include_top_episodes ?? true) },
      }),
    ),
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
    run(() => captivate.request("GET", `/insights/${show_id}/monthly${episode_id ? `/${episode_id}` : ""}`)),
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
    },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, episode_id, start, end, interval, timezone, country_code, breakdowns }) =>
    run(() =>
      captivate.request("POST", `/insights/${show_id}/range${episode_id ? `/${episode_id}` : ""}`, {
        body: {
          start,
          end,
          interval: interval ?? "1d",
          timezone: timezone ?? "UTC",
          countryCode: country_code ?? null,
          types: breakdowns ?? BREAKDOWNS.filter((b) => !(episode_id && b === "byEpisode")),
        },
      }),
    ),
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
      return captivate.request("POST", `/insights/${show_id}/compare`, { body: episodes });
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
      duration_seconds: z.number().int().positive().optional().describe("Episode duration in seconds"),
      timezone: z.string().optional().describe("IANA timezone (default UTC)"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ show_id, episode_id, start, end, duration_seconds, timezone }) =>
    run(() =>
      captivate.request("POST", `/insights/${show_id}/web-player/${episode_id}`, {
        body: {
          dateRange: { gte: start, lte: end },
          ...(duration_seconds ? { duration: String(duration_seconds) } : {}),
          timezone: timezone ?? "UTC",
        },
      }),
    ),
);

await server.connect(new StdioServerTransport());
