// Serverless wrapper for Express server on Vercel
// This makes the Express server available alongside the existing serverless functions
// Routes are available at /api/express/make-server-6d46752d/*
import type { VercelRequest, VercelResponse } from '@vercel/node';
import express from 'express';
import cors from 'cors';
import serverlessHttp from 'serverless-http';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

// Initialize Supabase client (replaces SQLite in production)
function getSupabaseClient() {
  const supabaseUrl = config.supabase.url;
  const supabaseKey = config.supabase.anonKey;

  if (!supabaseUrl || !supabaseKey || supabaseUrl.includes('YOUR_') || supabaseKey.includes('YOUR_')) {
    console.error('Missing Supabase credentials. Express server requires Supabase on Vercel.');
    return null;
  }

  return createClient(supabaseUrl, supabaseKey);
}

// Create Express app
const app = express();

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Helper functions
function generateEventCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function sendError(res: express.Response, statusCode: number, error: string, details?: any, hint?: string) {
  return res.status(statusCode).json({
    error,
    ...(details && { details }),
    ...(hint && { hint }),
  });
}

// Import and adapt all routes from the Express server
// We'll use Supabase instead of SQLite

// Health check
app.get('/make-server-6d46752d/health', (req, res) => {
  return res.json({ status: 'ok', timestamp: new Date().toISOString(), server: 'express' });
});

// Database health check
app.get('/make-server-6d46752d/health/db', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      return res.status(503).json({
        status: 'error',
        database: 'disconnected',
        error: 'Supabase not configured',
        server: 'express',
      });
    }

    // Test connection
    const { error } = await supabase.from('events').select('count').limit(1);
    if (error) {
      return res.status(503).json({
        status: 'error',
        database: 'connected',
        error: error.message,
        server: 'express',
      });
    }

    return res.json({
      status: 'ok',
      database: 'connected',
      timestamp: new Date().toISOString(),
      server: 'express',
    });
  } catch (error: any) {
    return res.status(503).json({
      status: 'error',
      database: 'disconnected',
      error: error.message,
      server: 'express',
    });
  }
});

// Create a new event
app.post('/make-server-6d46752d/events', async (req, res) => {
  try {
    const { name, theme, description, date, time, location, code } = req.body;
    const supabase = getSupabaseClient();

    if (!supabase) {
      return sendError(res, 500, 'Database not configured', null, 'Set up Supabase credentials');
    }

    if (!name || !theme) {
      return sendError(res, 400, 'Event name and theme are required');
    }

    let eventCode = code ? String(code).toUpperCase() : generateEventCode();
    const eventId = `event_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
    const now = new Date().toISOString();

    // Check for existing event
    if (code) {
      const { data: existing } = await supabase
        .from('events')
        .select('*')
        .eq('code', eventCode)
        .single();

      if (existing) {
        return res.json({
          success: true,
          event: existing,
        });
      }
    }

    // Generate unique code
    let attempts = 0;
    while (attempts < 10) {
      const { data: check } = await supabase
        .from('events')
        .select('code')
        .eq('code', eventCode)
        .single();

      if (!check) break;
      eventCode = generateEventCode();
      attempts++;
    }

    const eventData = {
      id: eventId,
      name: name.trim(),
      theme: theme.trim(),
      description: description?.trim() || '',
      code: eventCode,
      date: date || new Date().toISOString().split('T')[0],
      time: time || new Date().toTimeString().slice(0, 5),
      location: location?.trim() || null,
      is_active: true,
      created_at: now,
      updated_at: now,
    };

    const { data: newEvent, error } = await supabase
      .from('events')
      .insert(eventData)
      .select()
      .single();

    if (error) {
      return sendError(res, 500, 'Failed to create event', error.message);
    }

    return res.json({ success: true, event: newEvent });
  } catch (error: any) {
    return sendError(res, 500, 'Failed to create event', error.message);
  }
});

// Get event by code
app.get('/make-server-6d46752d/events/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const supabase = getSupabaseClient();

    if (!supabase) {
      return sendError(res, 500, 'Database not configured');
    }

    const { data: event, error } = await supabase
      .from('events')
      .select('*')
      .eq('code', code)
      .single();

    if (error || !event) {
      return sendError(res, 404, 'Event not found', null, 'Verify the event code is correct');
    }

    // Get preferences
    const { data: preferences } = await supabase
      .from('guest_preferences')
      .select('*')
      .eq('event_code', code);

    const formattedPreferences = (preferences || []).map((p: any) => ({
      userId: p.guest_id,
      artists: Array.isArray(p.artists) ? p.artists : (typeof p.artists === 'string' ? JSON.parse(p.artists || '[]') : []),
      genres: Array.isArray(p.genres) ? p.genres : (typeof p.genres === 'string' ? JSON.parse(p.genres || '[]') : []),
      recentTracks: Array.isArray(p.recent_tracks) ? p.recent_tracks : (typeof p.recent_tracks === 'string' ? JSON.parse(p.recent_tracks || '[]') : []),
      spotifyPlaylists: Array.isArray(p.spotify_playlists) ? p.spotify_playlists : (typeof p.spotify_playlists === 'string' ? JSON.parse(p.spotify_playlists || '[]') : []),
      tracksData: typeof p.tracks_data === 'object' ? p.tracks_data : (typeof p.tracks_data === 'string' ? JSON.parse(p.tracks_data || '[]') : []),
      stats: typeof p.stats === 'object' ? p.stats : (typeof p.stats === 'string' ? JSON.parse(p.stats || '{}') : {}),
      source: p.source || 'manual',
      submittedAt: p.submitted_at,
    }));

    return res.json({
      success: true,
      event: {
        ...event,
        preferences: formattedPreferences,
      },
    });
  } catch (error: any) {
    return sendError(res, 500, 'Failed to fetch event', error.message);
  }
});

// Submit guest preferences
app.post('/make-server-6d46752d/events/:code/preferences', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const preferences = req.body;
    const guestId = preferences.guestId || `guest_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
    const supabase = getSupabaseClient();

    if (!supabase) {
      return sendError(res, 500, 'Database not configured');
    }

    const tracksData = preferences.tracksData || preferences.tracks || [];
    const stats = preferences.stats || {};
    const now = new Date().toISOString();

    const guestPreferences = {
      event_code: code,
      guest_id: guestId,
      artists: Array.isArray(preferences.artists) ? preferences.artists : (preferences.artists || []),
      genres: Array.isArray(preferences.genres) ? preferences.genres : (preferences.genres || []),
      recent_tracks: Array.isArray(preferences.recentTracks) ? preferences.recentTracks : (preferences.recentTracks || []),
      spotify_playlists: Array.isArray(preferences.spotifyPlaylists) ? preferences.spotifyPlaylists : (preferences.spotifyPlaylists || []),
      spotify_analyzed: preferences.spotifyAnalyzed || preferences.source === 'spotify',
      source: preferences.source || 'manual',
      tracks_data: tracksData,
      stats: stats,
      submitted_at: now,
    };

    const { error } = await supabase
      .from('guest_preferences')
      .upsert(guestPreferences, {
        onConflict: 'event_code,guest_id',
      });

    if (error) {
      return sendError(res, 500, 'Failed to save preferences', error.message);
    }

    // Store tracks in event_songs
    if (tracksData && tracksData.length > 0) {
      for (const track of tracksData) {
        const trackId = track.id;
        const trackName = track.name;
        const artistName = Array.isArray(track.artists) ? track.artists[0] : (track.artists || 'Unknown Artist');
        const albumName = track.album || null;
        const popularity = track.popularity || 0;

        // Check if song exists and increment frequency
        const { data: existing } = await supabase
          .from('event_songs')
          .select('frequency')
          .eq('event_code', code)
          .eq('spotify_track_id', trackId)
          .eq('track_name', trackName)
          .eq('artist_name', artistName)
          .single();

        if (existing) {
          // Increment frequency
          await supabase
            .from('event_songs')
            .update({ frequency: ((existing as any).frequency || 0) + 1 })
            .eq('event_code', code)
            .eq('spotify_track_id', trackId)
            .eq('track_name', trackName)
            .eq('artist_name', artistName);
        } else {
          // Insert new song
          await supabase
            .from('event_songs')
            .insert({
              event_code: code,
              spotify_track_id: trackId,
              track_name: trackName,
              artist_name: artistName,
              album_name: albumName,
              popularity: popularity,
              frequency: 1,
            });
        }
      }
    }

    return res.json({ success: true, guestId });
  } catch (error: any) {
    return sendError(res, 500, 'Failed to submit preferences', error.message);
  }
});

// Note: Additional routes (insights, Spotify, song requests, etc.) are handled by the existing
// serverless function at /api/[...path].ts. The Express server here provides the core MVP functionality.
// You can add more routes here as needed by adapting them from server/local-server.js

// Wrap the Express app
const serverlessHandler = serverlessHttp(app, {
  request: (request: any, event: any, context: any) => {
    // Extract the path from the Vercel request
    // Vercel passes the path in req.url, but we need to handle it properly
    const path = event.path || request.url || '/';
    // Remove /api/express prefix if present
    let cleanPath = path.replace(/^\/api\/express/, '');
    // Ensure path starts with /make-server-6d46752d for our routes
    if (!cleanPath.startsWith('/make-server-6d46752d')) {
      cleanPath = '/make-server-6d46752d' + (cleanPath === '/' ? '/health' : cleanPath);
    }
    request.url = cleanPath;
    request.path = cleanPath.split('?')[0];
  },
});

// Export Vercel serverless function
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Convert Vercel request to AWS Lambda-style event (which serverless-http expects)
  const event = {
    httpMethod: req.method || 'GET',
    path: req.url || '/',
    headers: req.headers,
    queryStringParameters: req.query as Record<string, string> | undefined,
    body: req.body ? JSON.stringify(req.body) : undefined,
    isBase64Encoded: false,
  };

  const context = {} as any;

  // Call serverless handler
  try {
    const result = await serverlessHandler(event, context);
    
    // Set status code
    res.statusCode = result.statusCode || 200;
    
    // Set headers
    if (result.headers) {
      Object.entries(result.headers).forEach(([key, value]) => {
        res.setHeader(key, value as string);
      });
    }
    
    // Send body
    if (result.body) {
      // Parse body if it's JSON
      try {
        const body = JSON.parse(result.body);
        res.json(body);
      } catch {
        res.send(result.body);
      }
    } else {
      res.end();
    }
  } catch (error: any) {
    console.error('Express server error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

