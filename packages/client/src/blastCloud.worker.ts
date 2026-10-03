/// <reference lib="webworker" />
import { flyCloud, type BlastSample, type Cloud } from './blastCloud.js';

/** A blast's dust to fly (see flyCloud), and the answer: its pieces' arrays (moved, not copied). */
export interface CloudRequest {
  id: number;
  sample: BlastSample;
}
export interface CloudResponse {
  id: number;
  cloud: Cloud;
}

self.onmessage = (ev: MessageEvent<CloudRequest>) => {
  const cloud = flyCloud(ev.data.sample);
  const res: CloudResponse = { id: ev.data.id, cloud };
  self.postMessage(res, [cloud.start.buffer, cloud.velocity.buffer, cloud.land.buffer, cloud.spin.buffer, cloud.size.buffer, cloud.material.buffer]);
};
