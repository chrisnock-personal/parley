// src/services/transcriptService.ts -reading group transcript lines (written
// by the transcriber service, see transcriber/) and pruning them to the
// retention in system_settings.
import { query } from '../db/pool';

export interface TranscriptLine {
  id: string;               // BIGSERIAL, as a string (pg returns int8 as text)
  speaker_extension: string;
  speaker_name: string | null;
  text: string;
  spoken_at: string;
}

/** Lines for one group, oldest first. With `afterId`, only newer lines (the
 * client polls this way); without it, the most recent `limit` lines. */
export async function listLines(groupId: string, afterId?: string, limit = 100): Promise<TranscriptLine[]> {
  if (afterId) {
    const { rows } = await query<TranscriptLine>(
      `SELECT id, speaker_extension, speaker_name, text, spoken_at FROM intercom_transcript_lines
        WHERE group_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [groupId, afterId, limit]);
    return rows;
  }
  const { rows } = await query<TranscriptLine>(
    `SELECT * FROM (
       SELECT id, speaker_extension, speaker_name, text, spoken_at FROM intercom_transcript_lines
        WHERE group_id = $1 ORDER BY id DESC LIMIT $2
     ) recent ORDER BY id`,
    [groupId, limit]);
  return rows;
}

