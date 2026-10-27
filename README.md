# Captivate MCP

An [MCP](https://modelcontextprotocol.io) server for [Captivate.fm](https://www.captivate.fm) podcast hosting. It lets Claude (or any MCP client) read your shows, episodes and listening analytics, so you can ask things like:

- *"How did last week's episode do in its first 7 days compared to the previous three?"*
- *"Which countries and apps do my listeners use this quarter?"*
- *"Show me monthly downloads for the past year."*

The server is **read-only**: it never creates, edits or publishes anything in your Captivate account.

> Unofficial project, not affiliated with Captivate. Built on the public [Captivate API](https://docs.captivate.fm).

## Tools

| Tool | What it returns |
|---|---|
| `list_shows` | All podcasts you have access to |
| `get_show` | Show details and RSS feed URL |
| `list_episodes` | Episodes of a show (optionally scheduled only, filtered by title) |
| `get_episode` | Full episode details: show notes, media, transcript fields |
| `get_overview_analytics` | Downloads and unique listeners for a show or episode in a date range |
| `get_total_downloads` | All-time downloads for a show or episode |
| `get_monthly_downloads` | Downloads per month, past 12 months |
| `get_average_downloads` | Average downloads per interval (default 28 days) |
| `get_range_analytics` | Time series plus breakdowns by country, app, OS, device, episode |
| `compare_episodes` | Side-by-side performance of two or more episodes |
| `get_web_player_analytics` | Listening behaviour and drop-off in Captivate's web player |

## Get your API credentials

In Captivate, open **My Account → API** and generate an API token. You need two values:

- `CAPTIVATE_USER_ID` – your user ID shown on that page
- `CAPTIVATE_API_TOKEN` – the API token

## Install

Requires Node.js 18 or newer.

### Claude Code

```bash
claude mcp add captivate \
  -e CAPTIVATE_USER_ID=your-user-id \
  -e CAPTIVATE_API_TOKEN=your-api-token \
  -- npx -y github:DannyOosterveer/captivate-mcp
```

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "captivate": {
      "command": "npx",
      "args": ["-y", "github:DannyOosterveer/captivate-mcp"],
      "env": {
        "CAPTIVATE_USER_ID": "your-user-id",
        "CAPTIVATE_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### From source

```bash
git clone https://github.com/DannyOosterveer/captivate-mcp.git
cd captivate-mcp
npm install
```

Then point your MCP client at `node /path/to/captivate-mcp/dist/index.js` with the two environment variables set.

## Notes

- Dates are ISO 8601 (`2026-01-31` or `2026-01-31T00:00:00Z`).
- The API token is exchanged for a session token on first use and refreshed automatically when it expires.
- `CAPTIVATE_API_URL` can override the API base URL (default `https://api.captivate.fm`).

## License

MIT
