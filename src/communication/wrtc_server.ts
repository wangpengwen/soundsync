import { EventEmitter, once } from 'events';
import bonjour from 'bonjour';
import _ from 'lodash';
import superagent from 'superagent';
import debug from 'debug';

import { SoundSyncHttpServer } from './http_server';
import { WebrtcPeer } from './wrtc_peer';
import { getLocalPeer } from './local_peer';
import { ControllerMessage } from './messages';
import { Peer } from './peer';
import { waitUntilIceGatheringStateComplete } from '../utils/wait_for_ice_complete';

const log = debug('soundsync:wrtc');

export class WebrtcServer extends EventEmitter {
  peers: {[uuid: string]: Peer} = {};
  coordinatorPeer: Peer;

  constructor() {
    super();
    log(`Creating new Webrtc server with peer uuid ${getLocalPeer().uuid}`);
    this.peers[getLocalPeer().uuid] = getLocalPeer();
  }

  attachToSignalingServer(httpServer: SoundSyncHttpServer) {
    this.coordinatorPeer = getLocalPeer();
    this.coordinatorPeer.coordinator = true;
    this.coordinatorPeer.on('controllerMessage:all', ({message}: {message: ControllerMessage}) => {
      this.emit(`peerControllerMessage:${message.type}`, {peer: getLocalPeer(), message});
    });

    httpServer.router.post('/connect_webrtc_peer', async (ctx) => {
      const { name, uuid, sdp } = ctx.request.body;
      log(`Received new connection request from HTTP from peer ${name} with uuid ${uuid}`);
      const peer = new WebrtcPeer({
        webrtcServer: this,
        uuid,
        name,
        connectHandler: async (peer: WebrtcPeer) => {
          // Todo: handle reconnection here
        }
      });

      await peer.connection.setRemoteDescription(sdp);
      const answer = await peer.connection.createAnswer()

      peer.connection.setLocalDescription(answer);
      peer.log(`Responding with offer`);
      ctx.body = {
        status: 'ok',
        sdp: peer.connection.localDescription,
        uuid: getLocalPeer().uuid,
      }
      this.peers[uuid] = peer;
    });

    bonjour().publish({
      name: 'soundsync',
      port: httpServer.port,
      type: 'soundsync'
    });

    // httpServer.router.post('/ice_candidate', async (ctx) => {
    //   const { uuid, iceCandidates } = ctx.request.body;
    //   if (iceCandidates) {
    //     for (const iceCandidate of iceCandidates) {
    //       await this.peers[uuid].connection.addIceCandidate(iceCandidate);
    //     }
    //   }
    //   ctx.body = {
    //     status: 'ok',
    //     candidates: this.peers[uuid].candidates,
    //   };
    //   this.peers[uuid].candidates = [];
    // });
  }

  async connectToCoordinatorHost(host: string) {
    let coordinatorHost = host;
    if (!coordinatorHost) {
      log('Looking for a coordinator with Bonjour...');
      const service: any = await new Promise((resolve) => {
        bonjour().findOne({
          type: 'soundsync',
        }, resolve);
      });
      coordinatorHost = `${service.addresses[0]}:${service.port}`;
    }

    const name = getLocalPeer().name;
    const peer = new WebrtcPeer({
      name,
      webrtcServer: this,
      uuid: 'placeholderForCoordinatorUuid',
      coordinator: true,
      connectHandler: async (peer: WebrtcPeer) => {
        const offer = await peer.connection.createOffer();
        await peer.connection.setLocalDescription(offer);
        await waitUntilIceGatheringStateComplete(peer.connection);

        const {body: {sdp, uuid}} = await superagent.post(`${coordinatorHost}/connect_webrtc_peer`)
          .send({
            name,
            uuid: getLocalPeer().uuid,
            sdp: peer.connection.localDescription,
          });

          peer.setUuid(uuid);
          peer.log(`Got response from other peer http server`);
          await peer.connection.setRemoteDescription(sdp);
          await once(peer, 'connected');
        }
    });

    this.coordinatorPeer = peer;
    await peer.connect();
    this.peers[peer.uuid] = peer;
  }

  async broadcast(message: ControllerMessage, ignorePeerByUuid: string[] = []) {
    const sendToPeer = (peer) => {
      if (ignorePeerByUuid.includes(peer.uuid)) {
        return;
      }
      return peer.sendControllerMessage(message);
    }
    await Promise.all([
      ..._.map(this.peers, sendToPeer),
      sendToPeer(this.coordinatorPeer),
    ]);
  }

  getPeerByUuid = (uuid: string) => {
    if (!this.peers[uuid]) {
      this.peers[uuid] = new WebrtcPeer({
        uuid,
        webrtcServer: this,
        name: 'remote',
        connectHandler: async (peer: WebrtcPeer) => {
          const offer = await peer.connection.createOffer();
          await peer.connection.setLocalDescription(offer);
          await waitUntilIceGatheringStateComplete(peer.connection);
          this.coordinatorPeer.sendControllerMessage({
            type: 'peerConnectionInfo',
            peerUuid: peer.uuid,
            offer: peer.connection.localDescription,
          });
          await once(peer, 'connected');
        }
      });
    }
    return this.peers[uuid];
  }

  unregisterPeer = (peer: WebrtcPeer) => {
    delete this.peers[peer.uuid];
    if (this.coordinatorPeer === peer) {
      this.coordinatorPeer = undefined;
    }
  }
}
