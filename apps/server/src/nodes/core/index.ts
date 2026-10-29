import type { AnyNodeDefinition } from '@transcoda/sdk';
import {
  coverAttachments,
  encodeAudio,
  encodeVideo,
  keepLanguages,
  remux,
  reorderTracks,
  setDefaultTrack,
} from './actions.ts';
import { alreadyProcessed } from './already-processed.ts';
import { checkSource } from './check-source.ts';
import { fileMatches, hasStream, videoIs } from './conditions.ts';
import { embedSidecarSubtitles } from './embed-subtitles.ts';
import { moveCopy, notifyWebhook, render, replaceOriginal, sizeGate } from './finish.ts';
import { removeDuplicateAudio } from './remove-duplicate-audio.ts';
import { runSubworkflow, subworkflowEnd, subworkflowStart } from './subworkflow.ts';
import { inputLibrary, inputManual, inputWebhook } from './triggers.ts';

export const coreNodes: AnyNodeDefinition[] = [
  inputLibrary,
  inputWebhook,
  inputManual,
  videoIs,
  fileMatches,
  hasStream,
  checkSource,
  alreadyProcessed,
  subworkflowStart,
  subworkflowEnd,
  runSubworkflow,
  keepLanguages,
  setDefaultTrack,
  reorderTracks,
  coverAttachments,
  encodeVideo,
  encodeAudio,
  removeDuplicateAudio,
  remux,
  embedSidecarSubtitles,
  render,
  sizeGate,
  replaceOriginal,
  moveCopy,
  notifyWebhook,
];
