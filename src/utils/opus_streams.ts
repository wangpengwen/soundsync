import SpeexResampler from 'speex-resampler';
import MiniPass from 'minipass';
import { OpusEncoder, OpusApplication, OpusDecoder } from './opus';
import {
  AudioChunkStream, AudioChunkStreamOutput, AudioChunkStreamEncoder, AudioChunkStreamDecoder,
} from './chunk_stream';
import { OPUS_ENCODER_RATE, OPUS_ENCODER_CHUNK_SAMPLES_COUNT, OPUS_ENCODER_CHUNK_DURATION } from './constants';

export class OpusEncodeStream extends MiniPass {
  encoder: OpusEncoder;
  readyPromise: Promise<unknown>;

  constructor(sampleRate: number, channels: number, application: OpusApplication) {
    super({
      objectMode: true,
    });
    this.encoder = new OpusEncoder(sampleRate, channels, application);
    this.readyPromise = this.encoder.setup();
  }

  write(d: any, encoding?: string | (() => void), cb?: () => void) {
    this.readyPromise
      .then(() => this.encoder.encode(d.chunk))
      .then((frame) => {
        if (this.emittedEnd) {
          return;
        }

        super.write({
          i: d.i,
          chunk: frame,
        });
        if (cb) {
          cb();
        }
      });

    return true;
  }
}

export class OpusDecodeStream extends MiniPass {
  decoder: OpusDecoder;
  readyPromise: Promise<unknown>;

  constructor(sampleRate: number, channels: number) {
    super({
      objectMode: true,
    });
    this.decoder = new OpusDecoder(sampleRate, channels);
    this.readyPromise = this.decoder.setup();
  }

  async _handleChunk(d: AudioChunkStreamOutput, cb?: () => void) {
    await this.readyPromise;
    if (this.emittedEnd) {
      return;
    }
    const decodedFrame = this.decoder.decodeFloat(d.chunk);
    super.write({
      i: d.i,
      chunk: Buffer.from(decodedFrame),
    });
    if (cb) {
      cb();
    }
  }

  write(d: any, encoding?: string | (() => void), cb?: () => void) {
    this._handleChunk(d, cb);
    return true;
  }
}

export const createAudioEncodedStream = (sourceStream: NodeJS.ReadableStream, sourceRate: number, channels: number) => {
  let source = sourceStream;
  if (sourceRate !== OPUS_ENCODER_RATE) {
    const resampler = new SpeexResampler.TransformStream(channels, sourceRate, OPUS_ENCODER_RATE);
    source = source.pipe(resampler);
  }
  const chunkStream = new AudioChunkStream(
    source,
    OPUS_ENCODER_CHUNK_DURATION,
    OPUS_ENCODER_CHUNK_SAMPLES_COUNT * channels * 2,
  ); // *2 because this is 16bits so 2 bytes
  const opusEncoderStream = new OpusEncodeStream(OPUS_ENCODER_RATE, channels, OpusApplication.OPUS_APPLICATION_AUDIO);
  const chunkEncoder = new AudioChunkStreamEncoder();
  return chunkStream
    .pipe(opusEncoderStream)
    .pipe(chunkEncoder);
};

export const createAudioDecodedStream = (encodedStream: MiniPass, channels: number) => {
  const chunkDecoderStream = new AudioChunkStreamDecoder();
  const opusDecoderStream = new OpusDecodeStream(OPUS_ENCODER_RATE, channels);
  return encodedStream
    .pipe(chunkDecoderStream)
    .pipe(opusDecoderStream);
};
