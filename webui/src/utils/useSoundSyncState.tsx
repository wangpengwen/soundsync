import React, {
  useCallback, useEffect, createContext, useReducer, useContext,
} from 'react';

import { sortBy, some } from 'lodash-es';
import { createAction, handleActions } from 'redux-actions';
import produce from 'immer';
import { isHidden } from './hiddenUtils';
import { onSoundStateChange, onPeersChange } from './coordinator_communication';
import { getAudioSourcesSinksManager } from '../../../src/audio/get_audio_sources_sinks_manager';
import { getPeersManager } from '../../../src/communication/get_peers_manager';
import { PeersManager } from '../../../src/communication/peers_manager';

const initialState = {
  stateVersion: 0,
  registeringForPipe: { selectedSink: null, selectedSource: null },
  showHidden: false,
};

const soundSyncContext = createContext({
  state: initialState,
  dispatch: (...args) => {},
  audioSourcesSinksManager: getAudioSourcesSinksManager(),
  peersManagers: {},
});

const stateUpdate = createAction('stateUpdate');
const registerForPipe = createAction('registerForPipe');
const unregisterForPipe = createAction('unregisterForPipe');
const changeHiddenVisibility = createAction('changeHiddenVisibility');

export const SoundSyncProvider = ({ children }) => {
  const [state, dispatch] = useReducer(handleActions({
    [stateUpdate.toString()]: produce((s) => {
      // used to force react refresh, the state is already in the audioSourcesSinksManager object
      s.stateVersion++;
    }),
    [registerForPipe.toString()]: produce((s, { payload }) => {
      if (payload.type === 'sink') {
        s.registeringForPipe.selectedSink = payload.audioObject;
      } else {
        s.registeringForPipe.selectedSource = payload.audioObject;
      }
    }),
    [unregisterForPipe.toString()]: produce((s) => {
      s.registeringForPipe = {};
    }),
    [changeHiddenVisibility.toString()]: produce((s, { payload }) => {
      s.showHidden = payload;
    }),
  }, initialState), initialState);

  const refreshData = useCallback(async () => {
    dispatch(stateUpdate());
  }, []);

  useEffect(() => {
    refreshData();
    onSoundStateChange(refreshData);
    onPeersChange(refreshData);
  }, []);

  return (
    <soundSyncContext.Provider value={{
      state,
      dispatch,
      audioSourcesSinksManager: getAudioSourcesSinksManager(),
      peersManagers: getPeersManager(),
    }}
    >
      {children}
    </soundSyncContext.Provider>
  );
};

export const useIsConnected = () => some(useContext(soundSyncContext).peersManagers.peers, (peer) => !peer.isLocal && peer.state === 'connected');

const audioSourceSinkGetter = (collection, withHidden) => {
  const orderedCollection = sortBy(collection, ({ name }) => (isHidden(name) ? 10 : 0)).filter((s) => s.peer && s.peer.state === 'connected' && s.available !== false);
  if (!withHidden) {
    return orderedCollection.filter(({ name }) => !isHidden(name));
  }
  return orderedCollection;
};

export const getContextAudioSourcesSinksManager = () => useContext(soundSyncContext).audioSourcesSinksManager;

export const useSinks = ({ withHidden = true } = {}) => audioSourceSinkGetter(getContextAudioSourcesSinksManager().sinks, withHidden);
export const useSources = ({ withHidden = true } = {}) => audioSourceSinkGetter(getContextAudioSourcesSinksManager().sources, withHidden);
export const usePipes = () => getContextAudioSourcesSinksManager().sinks.filter((s) => s.pipedFrom).map((s) => ({ sinkUuid: s.uuid, sourceUuid: s.pipedFrom }));

export const usePeersManager = () => useContext(soundSyncContext).peersManagers as PeersManager;
export const usePeers = () => useContext(soundSyncContext).peersManagers.peers;
export const usePeer = (uuid) => usePeersManager().getConnectedPeerByUuid(uuid);

export const useRegisterForPipe = (type, audioObject) => {
  const { state, dispatch } = useContext(soundSyncContext);
  const isSelectedElement = state.registeringForPipe.selectedSink === audioObject || state.registeringForPipe.selectedSource === audioObject;
  const selectedObjectType = state.registeringForPipe.selectedSink ? 'sink' : state.registeringForPipe.selectedSource ? 'source' : null;
  const shouldShow = type !== selectedObjectType || isSelectedElement;

  useEffect(() => {
    // used to handle a click outside that will unregister the selected element
    const clickListener = (e) => {
      if (!e.target.closest('.source-container,.sink-container')) {
        dispatch(unregisterForPipe());
      }
    };
    if (isSelectedElement) {
      document.addEventListener('click', clickListener);
    }
    return () => {
      document.removeEventListener('click', clickListener);
    };
  }, [isSelectedElement]);

  return [shouldShow, isSelectedElement, () => {
    // event handler on click
    if (selectedObjectType && selectedObjectType !== type) {
      const sink = type === 'sink' ? audioObject : state.registeringForPipe.selectedSink;
      const source = type === 'source' ? audioObject : state.registeringForPipe.selectedSource;
      dispatch(unregisterForPipe());
      sink.patch({
        pipedFrom: source.uuid,
      });
      return { piped: true };
    }
    dispatch(registerForPipe({ type, audioObject }));
    return { piped: false };
  }];
};

export const useUnpipeAction = (sink) => {
  const { dispatch } = useContext(soundSyncContext);

  return useCallback(async () => {
    dispatch(unregisterForPipe());
    sink.patch({
      pipedFrom: null,
    });
  }, [sink]);
};

export const useShowHidden = () => useContext(soundSyncContext).state.showHidden;
export const useSetHiddenVisibility = () => {
  const { dispatch } = useContext(soundSyncContext);
  return (...args) => dispatch(changeHiddenVisibility(...args));
};
