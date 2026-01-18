# MetaMesh Plugin: TMDB

A MetaMesh plugin that fetches metadata from The Movie Database (TMDB) API.

## Description

This plugin enriches video metadata by querying the TMDB API:

- **Search by IMDB ID**: Uses existing IMDB ID for precise matching
- **Search by title**: Falls back to title/year search
- **Image download**: Downloads poster and backdrop images to `/files/poster/`
- **Rich metadata**: Fetches plot, rating, genres, studios

**Note**: This runs on the background queue as it makes external API calls.

## Metadata Fields

| Field | Description |
|-------|-------------|
| `tmdbid` | TMDB ID |
| `imdbid` | IMDB ID |
| `title` | Localized title |
| `originalTitle` | Original title |
| `movieYear` | Release year |
| `releasedate` | Full release date |
| `rating` | Vote average |
| `plot/eng` | English plot synopsis |
| `poster` | Poster image CID |
| `posterPath` | Poster file path |
| `backdrop` | Backdrop image CID |
| `backdropPath` | Backdrop file path |
| `genres` | Genre set |
| `studio` | Production company set |

## Dependencies

- Requires `file-info` and `filename-parser` plugins
- Optional: `jellyfin-nfo` (provides IMDB IDs from NFO files for better matching)

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiKey` | string | Yes | TMDB API key or v4 bearer token |
| `language` | select | No | Metadata language (default: en-US) |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/manifest` | GET | Plugin manifest |
| `/configure` | POST | Update configuration (API key) |
| `/process` | POST | Process a file |

## Running Locally

```bash
npm install
npm run build
npm start
```

## Docker

Build the image for the dev stack:

```bash
# From the plugin directory
docker build -t metamesh-plugin-tmdb:main .

# Restart the plugin container (if already running)
docker restart meta-plugin-tmdb-0
```

Run standalone:

```bash
docker run -p 8080:8080 metamesh-plugin-tmdb:main
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server host |
| `FILES_PATH` | `/files` | Base path for image downloads |

## License

MIT
