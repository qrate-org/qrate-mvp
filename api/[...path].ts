// Catch-all API route handler for Vercel
// Handles all /api/* routes that match /make-server-6d46752d/* from the frontend
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { config } from './config';

// Helper functions
function getSupabaseClient() {
  const supabaseUrl = config.supabase.url;
  const supabaseKey = config.supabase.anonKey;

  if (!supabaseUrl || !supabaseKey || supabaseUrl.includes('YOUR_') || supabaseKey.includes('YOUR_')) {
    console.error('Missing Supabase credentials. Using fallback mode.');
    return null;
  }

  return createClient(supabaseUrl, supabaseKey);
}

function sendError(res: VercelResponse, statusCode: number, error: string, details?: any, hint?: string) {
  return res.status(statusCode).json({
    error,
    ...(details && { details }),
    ...(hint && { hint }),
  });
}

function sendSuccess(res: VercelResponse, data: any) {
  return res.status(200).json(data);
}

function generateEventCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// In-memory fallback store (for when Supabase is not configured)
const fallbackStore = new Map<string, any>();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  // Add CORS headers to all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const supabase = getSupabaseClient();
  
  // Parse path - handle both array and string cases
  // In Vercel, catch-all routes store path segments in req.query.path
  let path: string[] = [];
  
  // Method 1: Try req.query.path (standard Vercel catch-all)
  if (req.query.path) {
    if (Array.isArray(req.query.path)) {
      path = req.query.path as string[];
    } else if (typeof req.query.path === 'string') {
      path = req.query.path.split('/').filter(Boolean);
    }
  }
  
  // Method 2: Parse from URL if path is still empty
  if (path.length === 0) {
    const url = req.url || '';
    const urlPath = url.split('?')[0]; // Remove query string
    const segments = urlPath.split('/').filter(Boolean);
    
    // Find 'api' segment and take everything after it
    const apiIndex = segments.indexOf('api');
    if (apiIndex !== -1 && apiIndex < segments.length - 1) {
      path = segments.slice(apiIndex + 1);
    } else if (segments.length > 0) {
      // If no 'api' found, might be direct path (after rewrite)
      path = segments;
    }
  }
  
  // Normalize route: remove empty segments, trim, handle trailing slashes
  const route = path
    .filter(segment => segment && segment.trim())
    .map(segment => segment.trim())
    .join('/')
    .toLowerCase()
    .replace(/^\/+|\/+$/g, ''); // Remove leading/trailing slashes
  
  // Debug logging (always log to help diagnose issues)
  console.log('[API Handler] Request Details:', {
    method: req.method,
    url: req.url,
    queryPath: req.query.path,
    parsedPath: path,
    normalizedRoute: route || '(empty)',
    query: Object.keys(req.query),
    hasBody: !!req.body,
    contentType: req.headers['content-type']
  });

  try {
    // Health check
    if (route === 'health') {
      return sendSuccess(res, { status: 'ok', timestamp: new Date().toISOString() });
    }

    // Database health check
    if (route === 'health/db') {
      if (!supabase) {
        return res.status(503).json({
          status: 'error',
          database: 'disconnected',
          error: 'Supabase not configured',
          hint: 'Set SUPABASE_URL and SUPABASE_ANON_KEY environment variables',
        });
      }
      return sendSuccess(res, {
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    }

    // Events routes
    if (route === 'events') {
      // Check method support for events route
      if (req.method !== 'POST') {
        return sendError(res, 405, 'Method not allowed', {
          method: req.method,
          allowedMethods: ['POST'],
          hint: 'Use POST method to create an event'
        });
      }
      
      // Parse body - Vercel should auto-parse JSON, but handle edge cases
      let body = req.body;
      if (!body) {
        // Body might be in raw format, try to read from request
        return sendError(res, 400, 'Request body is required', {
          hint: 'Ensure Content-Type is application/json and body contains event data'
        });
      }
      
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch (e) {
          return sendError(res, 400, 'Invalid JSON in request body', {
            error: e instanceof Error ? e.message : 'Parse error'
          });
        }
      }
      
      if (typeof body !== 'object' || body === null) {
        return sendError(res, 400, 'Request body must be a JSON object');
      }
      
      const { name, theme, description, date, time, location, code } = body;

      if (!name || !theme) {
        return sendError(res, 400, 'Event name and theme are required');
      }

      let eventCode = code ? String(code).toUpperCase() : generateEventCode();
      const eventId = `event_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
      const now = new Date().toISOString();

      if (supabase) {
        // Check for existing event with code
        const { data: existing } = await supabase
          .from('events')
          .select('*')
          .eq('code', eventCode)
          .single();

        if (existing && code) {
          return sendSuccess(res, { success: true, event: existing });
        }

        // Generate unique code if needed
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

        return sendSuccess(res, { success: true, event: newEvent });
      } else {
        // Fallback to in-memory store
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
        fallbackStore.set(`event:${eventCode}`, eventData);
        return sendSuccess(res, { success: true, event: eventData });
      }
    }

    // Get event by code: GET /api/events/:code
    if (path[0] === 'events' && path[1] && req.method === 'GET') {
      const code = path[1].toUpperCase();

      if (supabase) {
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

        return sendSuccess(res, {
          success: true,
          event: {
            ...event,
            preferences: formattedPreferences,
          },
        });
      } else {
        // Fallback
        const event = fallbackStore.get(`event:${code}`);
        if (!event) {
          return sendError(res, 404, 'Event not found');
        }
        return sendSuccess(res, { success: true, event });
      }
    }

    // Submit preferences: POST /api/events/:code/preferences
    if (path[0] === 'events' && path[2] === 'preferences' && req.method === 'POST') {
      const code = path[1].toUpperCase();
      const preferences = req.body;
      const guestId = preferences.guestId || `guest_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;

      if (supabase) {
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

            // Upsert song
            const { error: songError } = await supabase
              .from('event_songs')
              .upsert(
                {
                  event_code: code,
                  spotify_track_id: trackId,
                  track_name: trackName,
                  artist_name: artistName,
                  album_name: albumName,
                  popularity: popularity,
                  frequency: 1,
                },
                {
                  onConflict: 'event_code,spotify_track_id,track_name,artist_name',
                }
              );

            if (!songError) {
              // Increment frequency if exists
              await supabase.rpc('increment_song_frequency', {
                p_event_code: code,
                p_track_id: trackId,
                p_track_name: trackName,
                p_artist_name: artistName,
              });
            }
          }
        }

        return sendSuccess(res, { success: true, guestId });
      } else {
        // Fallback
        fallbackStore.set(`preferences:${code}:${guestId}`, preferences);
        return sendSuccess(res, { success: true, guestId });
      }
    }

    // Spotify auth endpoints - proxy to Spotify API
    if (route === 'spotify/auth' && req.method === 'GET') {
      const clientId = config.spotify.clientId;
      if (!clientId || clientId.includes('YOUR_')) {
        return sendError(res, 500, 'Spotify integration not configured', null, 'Set SPOTIFY_CLIENT_ID in config.ts');
      }

      const scopes = 'user-read-private playlist-read-private playlist-read-collaborative user-follow-read';
      const redirectUri = config.spotify.guestRedirectUri || `${req.headers.origin || 'https://qrate-mvp.vercel.app'}/guest`;
      const state = Math.random().toString(36).substring(7);

      const authUrl = `https://accounts.spotify.com/authorize?` +
        `response_type=code&` +
        `client_id=${clientId}&` +
        `scope=${encodeURIComponent(scopes)}&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `state=${state}`;

      return sendSuccess(res, { success: true, auth_url: authUrl });
    }

    // Spotify callback
    if (route === 'spotify/callback' && req.method === 'POST') {
      const { code } = req.body;
      const clientId = config.spotify.clientId;
      const clientSecret = config.spotify.clientSecret;

      if (!clientId || !clientSecret || clientId.includes('YOUR_') || clientSecret.includes('YOUR_')) {
        return sendError(res, 500, 'Spotify integration not configured', null, 'Set Spotify credentials in config.ts');
      }

      const redirectUri = config.spotify.guestRedirectUri || `${req.headers.origin || 'https://qrate-mvp.vercel.app'}/guest`;

      const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        return sendError(res, 400, 'Failed to exchange code for token', error);
      }

      const tokenData = await tokenResponse.json();
      return sendSuccess(res, {
        success: true,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
      });
    }

    // Spotify search
    if (route === 'spotify/search' && req.method === 'POST') {
      const { query: searchQuery, access_token, limit = 20 } = req.body;

      if (!searchQuery || !access_token) {
        return sendError(res, 400, 'Search query and access token are required');
      }

      const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=${limit}`;

      const response = await fetch(searchUrl, {
        headers: {
          'Authorization': `Bearer ${access_token}`,
        },
      });

      if (!response.ok) {
        return sendError(res, 400, 'Spotify search failed');
      }

      const data = await response.json();
      const tracks = (data.tracks?.items || []).map((track: any) => ({
        id: track.id,
        spotifyTrackId: track.id,
        trackName: track.name,
        artistName: track.artists[0]?.name || 'Unknown',
        albumName: track.album?.name || '',
        previewUrl: track.preview_url,
        durationMs: track.duration_ms,
        albumArt: track.album?.images?.[0]?.url,
      }));

      return sendSuccess(res, { success: true, tracks });
    }

    // Get insights
    if (path[0] === 'events' && path[2] === 'insights' && req.method === 'GET') {
      const code = path[1].toUpperCase();

      if (supabase) {
        const { data: preferences } = await supabase
          .from('guest_preferences')
          .select('*')
          .eq('event_code', code)
          .eq('source', 'spotify');

        if (!preferences || preferences.length === 0) {
          return sendSuccess(res, {
            success: true,
            insights: {
              totalGuests: 0,
              topGenres: [],
              topArtists: [],
              recommendations: [],
            },
          });
        }

        // Analyze preferences (simplified)
        const genreCounts: Record<string, number> = {};
        const artistCounts: Record<string, number> = {};

        preferences.forEach((pref: any) => {
          const genres = Array.isArray(pref.genres) ? pref.genres : (typeof pref.genres === 'string' ? JSON.parse(pref.genres || '[]') : []);
          const artists = Array.isArray(pref.artists) ? pref.artists : (typeof pref.artists === 'string' ? JSON.parse(pref.artists || '[]') : []);

          genres.forEach((genre: string) => {
            genreCounts[genre] = (genreCounts[genre] || 0) + 1;
          });

          artists.forEach((artist: string) => {
            artistCounts[artist] = (artistCounts[artist] || 0) + 1;
          });
        });

        const topGenres = Object.entries(genreCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([genre, count]) => ({
            name: genre,
            count,
            percentage: Math.round((count / preferences.length) * 100),
          }));

        const topArtists = Object.entries(artistCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([artist, count]) => ({ name: artist, count }));

        // Get top songs
        const { data: songs } = await supabase
          .from('event_songs')
          .select('*')
          .eq('event_code', code)
          .order('frequency', { ascending: false })
          .limit(15);

        const recommendations = (songs || []).map((song: any) => ({
          id: song.spotify_track_id,
          title: song.track_name,
          artist: song.artist_name,
          album: song.album_name || '',
          matchScore: Math.min(song.frequency * 10, 100),
          reasons: [
            `Appeared ${song.frequency} time${song.frequency > 1 ? 's' : ''} in guest playlists`,
            'Top crowd favorite',
          ],
          source: 'spotify',
        }));

        return sendSuccess(res, {
          success: true,
          insights: {
            totalGuests: preferences.length,
            topGenres,
            topArtists,
            recommendations,
          },
        });
      } else {
        return sendSuccess(res, {
          success: true,
          insights: {
            totalGuests: 0,
            topGenres: [],
            topArtists: [],
            recommendations: [],
          },
        });
      }
    }

    // Song requests endpoints (simplified - add more as needed)
    if (path[0] === 'events' && path[2] === 'requests' && req.method === 'GET') {
      const code = path[1].toUpperCase();
      
      if (supabase) {
        const { data: requests } = await supabase
          .from('song_requests')
          .select('*')
          .eq('event_code', code)
          .order('vote_count', { ascending: false });

        const formattedRequests = (requests || []).map((r: any) => ({
          id: r.id,
          eventCode: r.event_code,
          guestId: r.guest_id,
          spotifyTrackId: r.spotify_track_id,
          trackName: r.track_name,
          artistName: r.artist_name,
          albumName: r.album_name,
          previewUrl: r.preview_url,
          durationMs: r.duration_ms,
          status: r.status,
          voteCount: r.vote_count || 0,
          downvoteCount: r.downvote_count || 0,
          tipAmount: r.tip_amount || 0,
          requesterName: r.requester_name,
          submittedAt: r.submitted_at,
          metadata: typeof r.metadata === 'object' ? r.metadata : (typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : {}),
        }));

        return sendSuccess(res, { success: true, requests: formattedRequests });
      } else {
        return sendSuccess(res, { success: true, requests: [] });
      }
    }

    if (path[0] === 'events' && path[2] === 'requests' && req.method === 'POST') {
      const code = path[1].toUpperCase();
      const requestData = req.body;

      if (!requestData.trackName || !requestData.artistName || !requestData.guestId) {
        return sendError(res, 400, 'Track name, artist name, and guest ID are required');
      }

      if (supabase) {
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const now = new Date().toISOString();

        // Generate mock metadata
        const hashString = (str: string) => {
          let hash = 0;
          for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
          }
          return Math.abs(hash);
        };

        const hash = hashString(`${requestData.trackName}${requestData.artistName}`);
        const keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const bpm = 60 + (hash % 120);
        const key = keys[hash % keys.length];
        const energy = Math.min(100, 30 + (bpm - 60) / 2 + (hash % 30));
        const danceability = Math.min(100, Math.max(0, energy * 0.8 + (hash % 20)));

        const metadata = {
          bpm: Math.round(bpm),
          key,
          energy: Math.round(energy),
          danceability: Math.round(danceability),
        };

        const { data: newRequest, error } = await supabase
          .from('song_requests')
          .insert({
            id: requestId,
            event_code: code,
            guest_id: requestData.guestId,
            spotify_track_id: requestData.spotifyTrackId || null,
            track_name: requestData.trackName,
            artist_name: requestData.artistName,
            album_name: requestData.albumName || null,
            preview_url: requestData.previewUrl || null,
            duration_ms: requestData.durationMs || null,
            status: 'pending',
            vote_count: 0,
            downvote_count: 0,
            tip_amount: 0,
            requester_name: requestData.requesterName || null,
            submitted_at: now,
            metadata: metadata,
          })
          .select()
          .single();

        if (error) {
          return sendError(res, 500, 'Failed to submit request', error.message);
        }

        return sendSuccess(res, {
          success: true,
          request: {
            ...newRequest,
            metadata,
          },
        });
      } else {
        return sendError(res, 503, 'Database not configured', null, 'Set up Supabase for production');
      }
    }

    // Get top songs
    if (path[0] === 'events' && path[2] === 'top-songs' && req.method === 'GET') {
      const code = path[1].toUpperCase();

      if (supabase) {
        const { data: songs } = await supabase
          .from('event_songs')
          .select('*')
          .eq('event_code', code)
          .order('frequency', { ascending: false })
          .limit(15);

        const topSongs = (songs || []).map((song: any) => ({
          id: song.spotify_track_id,
          title: song.track_name,
          artist: song.artist_name,
          album: song.album_name || '',
          frequency: song.frequency,
          popularity: song.popularity || 0,
          spotifyTrackId: song.spotify_track_id,
        }));

        return sendSuccess(res, { success: true, songs: topSongs });
      } else {
        return sendSuccess(res, { success: true, songs: [] });
      }
    }

    // Get Spotify playlists
    if (route === 'spotify/playlists' && req.method === 'POST') {
      const { access_token } = req.body;

      if (!access_token) {
        return sendError(res, 400, 'Access token required');
      }

      const playlistsResponse = await fetch('https://api.spotify.com/v1/me/playlists?limit=50', {
        headers: {
          'Authorization': `Bearer ${access_token}`,
        },
      });

      if (!playlistsResponse.ok) {
        return sendError(res, 400, 'Failed to fetch playlists');
      }

      const playlistsData = await playlistsResponse.json();
      const playlists = (playlistsData.items || []).map((playlist: any) => ({
        id: playlist.id,
        name: playlist.name,
        tracks: { total: playlist.tracks.total },
        images: playlist.images || [],
        description: playlist.description,
      }));

      return sendSuccess(res, { success: true, playlists });
    }

    // Get playlist tracks
    if (route === 'spotify/playlist-tracks' && req.method === 'POST') {
      const { access_token, playlist_ids } = req.body;

      if (!access_token || !playlist_ids || !Array.isArray(playlist_ids)) {
        return sendError(res, 400, 'Access token and playlist IDs required');
      }

      const allTracks: any[] = [];
      const allArtists = new Set<string>();

      for (const playlistId of playlist_ids) {
        try {
          const tracksResponse = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50`, {
            headers: {
              'Authorization': `Bearer ${access_token}`,
            },
          });

          if (tracksResponse.ok) {
            const tracksData = await tracksResponse.json();
            for (const item of tracksData.items || []) {
              if (item.track && item.track.artists) {
                allTracks.push({
                  id: item.track.id,
                  name: item.track.name,
                  artists: item.track.artists.map((artist: any) => artist.name),
                  album: item.track.album?.name,
                  popularity: item.track.popularity,
                  preview_url: item.track.preview_url,
                });

                item.track.artists.forEach((artist: any) => {
                  allArtists.add(artist.name);
                });
              }
            }
          }
        } catch (error) {
          console.error(`Error fetching tracks for playlist ${playlistId}:`, error);
        }
      }

      return sendSuccess(res, {
        success: true,
        tracks: allTracks,
        artists: Array.from(allArtists),
        genres: [],
      });
    }

    // DJ Spotify auth
    if (route === 'spotify/dj/auth' && req.method === 'GET') {
      const clientId = config.spotify.clientId;
      if (!clientId || clientId.includes('YOUR_')) {
        return sendError(res, 500, 'Spotify integration not configured', null, 'Set SPOTIFY_CLIENT_ID in config.ts');
      }

      const scopes = 'user-read-private playlist-modify-public playlist-modify-private';
      const redirectUri = config.spotify.djRedirectUri || `${req.headers.origin || 'https://qrate-mvp.vercel.app'}/dj/spotify/callback`;
      const state = Math.random().toString(36).substring(7);

      const authUrl = `https://accounts.spotify.com/authorize?` +
        `response_type=code&` +
        `client_id=${clientId}&` +
        `scope=${encodeURIComponent(scopes)}&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `state=${state}`;

      return sendSuccess(res, { success: true, auth_url: authUrl });
    }

    // DJ Spotify callback
    if (route === 'spotify/dj/callback' && req.method === 'POST') {
      const { code } = req.body;
      const clientId = config.spotify.clientId;
      const clientSecret = config.spotify.clientSecret;

      if (!clientId || !clientSecret || clientId.includes('YOUR_') || clientSecret.includes('YOUR_')) {
        return sendError(res, 500, 'Spotify integration not configured', null, 'Set Spotify credentials in config.ts');
      }

      const redirectUri = config.spotify.djRedirectUri || `${req.headers.origin || 'https://qrate-mvp.vercel.app'}/dj/spotify/callback`;

      const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        return sendError(res, 400, 'Failed to exchange code for token', error);
      }

      const tokenData = await tokenResponse.json();
      return sendSuccess(res, {
        success: true,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
      });
    }

    // Request settings
    if (path[0] === 'events' && path[2] === 'request-settings' && req.method === 'GET') {
      const code = path[1].toUpperCase();

      if (supabase) {
        const { data: settings } = await supabase
          .from('request_settings')
          .select('*')
          .eq('event_code', code)
          .single();

        if (settings) {
          return sendSuccess(res, {
            success: true,
            settings: {
              eventCode: settings.event_code,
              requestsEnabled: settings.requests_enabled,
              votingEnabled: settings.voting_enabled,
              paidRequestsEnabled: settings.paid_requests_enabled,
              genreRestrictions: typeof settings.genre_restrictions === 'object' ? settings.genre_restrictions : (typeof settings.genre_restrictions === 'string' ? JSON.parse(settings.genre_restrictions || '[]') : []),
              artistRestrictions: typeof settings.artist_restrictions === 'object' ? settings.artist_restrictions : (typeof settings.artist_restrictions === 'string' ? JSON.parse(settings.artist_restrictions || '[]') : []),
              openTime: settings.open_time,
              closeTime: settings.close_time,
              minVoteThreshold: settings.min_vote_threshold || 0,
              maxRequestsPerGuest: settings.max_requests_per_guest || 10,
              autoAcceptThreshold: settings.auto_accept_threshold || 5,
              createdAt: settings.created_at,
              updatedAt: settings.updated_at,
            },
          });
        }
      }

      // Return defaults
      return sendSuccess(res, {
        success: true,
        settings: {
          eventCode: code,
          requestsEnabled: true,
          votingEnabled: true,
          paidRequestsEnabled: false,
          genreRestrictions: [],
          artistRestrictions: [],
          openTime: null,
          closeTime: null,
          minVoteThreshold: 0,
          maxRequestsPerGuest: 10,
          autoAcceptThreshold: 5,
        },
      });
    }

    // Update request settings
    if (path[0] === 'events' && path[2] === 'request-settings' && req.method === 'PUT') {
      const code = path[1].toUpperCase();
      const updates = req.body;

      if (supabase) {
        const now = new Date().toISOString();
        const settingsData = {
          event_code: code,
          requests_enabled: updates.requestsEnabled !== undefined ? updates.requestsEnabled : true,
          voting_enabled: updates.votingEnabled !== undefined ? updates.votingEnabled : true,
          paid_requests_enabled: updates.paidRequestsEnabled !== undefined ? updates.paidRequestsEnabled : false,
          genre_restrictions: updates.genreRestrictions || [],
          artist_restrictions: updates.artistRestrictions || [],
          open_time: updates.openTime || null,
          close_time: updates.closeTime || null,
          min_vote_threshold: updates.minVoteThreshold || 0,
          max_requests_per_guest: updates.maxRequestsPerGuest || 10,
          auto_accept_threshold: updates.autoAcceptThreshold || 5,
          updated_at: now,
        };

        const { error } = await supabase
          .from('request_settings')
          .upsert(settingsData, {
            onConflict: 'event_code',
          });

        if (error) {
          return sendError(res, 500, 'Failed to update request settings', error.message);
        }

        return sendSuccess(res, { success: true });
      } else {
        return sendError(res, 503, 'Database not configured');
      }
    }

    // Catch-all for unhandled routes
    // If route is empty, it might be a root API call
    if (!route || route === '') {
      return sendError(res, 404, 'API endpoint not specified', {
        method: req.method,
        url: req.url,
        hint: 'Valid endpoints: /api/health, /api/events (POST), /api/events/:code (GET), etc.',
      });
    }
    
    // Check if this might be a method mismatch (route exists but wrong method)
    // Common routes that only support specific methods
    const routeMethodMap: Record<string, string[]> = {
      'events': ['POST'],
      'health': ['GET'],
      'health/db': ['GET'],
    };
    
    if (routeMethodMap[route]) {
      const allowedMethods = routeMethodMap[route];
      if (!allowedMethods.includes(req.method || '')) {
        return sendError(res, 405, 'Method not allowed', {
          method: req.method,
          route: route,
          allowedMethods: allowedMethods,
          hint: `This endpoint only supports: ${allowedMethods.join(', ')}`,
        });
      }
    }
    
    return sendError(res, 404, 'Route not found', {
      method: req.method,
      path: route,
      url: req.url,
      hint: 'Check VERCEL_DEPLOYMENT.md for API documentation. Available routes: /api/health, /api/events, etc.',
    });
  } catch (error: any) {
    console.error('API error:', error);
    return sendError(res, 500, 'Internal server error', error.message);
  }
}


