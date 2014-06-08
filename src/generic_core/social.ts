/**
 * social.ts
 *
 * Interactions for network-specific social providers.
 *
 * To add new social providers, list them as dependencies in the primary
 * uProxy freedom manifest (./uproxy.json) with the 'SOCIAL-' prefix in the
 * name.
 *
 * e.g.
 *
 *  "dependencies": {
 *    ...
 *    "SOCIAL-websocket": {
 *      "url": "../lib/websocket-server/social.ws.json",
 *      "api": "social"
 *    },
 *    ...
 */
/// <reference path='user.ts' />

/// <reference path='../../node_modules/freedom-typescript-api/interfaces/freedom.d.ts' />
/// <reference path='../../node_modules/freedom-typescript-api/interfaces/promise.d.ts' />
/// <reference path='../../node_modules/freedom-typescript-api/interfaces/social.d.ts' />


module Social {

  // PREFIX is the string prefix indicating which social providers in the
  // freedom manifest we want to treat as a social provider for uProxy.
  var PREFIX:string = 'SOCIAL-';

  // Global mapping of social networks (without prefix) to the actual Network
  // class to interact with that social network.
  //
  // TODO: rather than make this global, this should be a parameter of the core.
  // This simplified Social to being a SocialNetwork and removes the need for
  // this module. `initializeNetworks` becomes part of the core constructor.
  export var networks:{[name:string]:Network} = {}

  /**
   * Go through network names and get references to each social provider.
   */
  export function initializeNetworks() {
    for (var dependency in freedom) {
      if (freedom.hasOwnProperty(dependency)) {
        if (dependency.indexOf(PREFIX) !== 0 ||
            'social' !== freedom[dependency].api) {
          continue;
        }

        var name = dependency.substr(PREFIX.length);
        var network = new Social.Network(name);
        Social.networks[name] = network;
      }
    }
    return Social.networks;
  }

  /**
   * Retrieve reference to the network |networkName|.
   */
  export function getNetwork(networkName:string) : Network {
    if (!(networkName in networks)) {
      console.warn('Network does not exist: ' + networkName);
      return null;
    }
    return networks[networkName];
  }

  /**
   * Social.Network - encapsulates a single network on a social provider.
   *
   * Maintains the local uProxy client's interaction as a user on the network.
   *
   * Also, deals with events from the social provider. 'onUserProfile' events
   * directly affect the roster of this network, while 'onClientState' and
   * 'onMessage' are passed on to the relevant user, assuming the user exists.
   *
   * NOTE: All JSON stringify / parse happens automatically through the
   * network's communication methods. The rest of the code should deal purely
   * with the data objects.
   *
   * Furthermore, at the Social.Network level, all communications deal directly
   * with the clientIds. This is because instanceIds occur at the User level, as
   * the User manages the instance <--> client mappings. (see 'user.ts')
   */
  export class Network implements Core.Persistent {

    // TODO: Review visibility of these attributes and the interface.
    public roster    :{[userId:string]:Core.User};
    // TODO: give real typing to metdata.
    public metadata  :any;  // Network name, description, icon, etc.

    // TODO: rename api to freedomApi.
    private api      :freedom.Social;
    // TODO: give real typing to provider. Ask Freedom not to use overloaded
    // types.
    private provider :any;  // Special freedom object which is both a function
                            // and object... cannot typescript.

    public myInstance :Core.LocalInstance;
    // Promise which delays all message handling until fully logged in.
    private onceLoggedIn_   :Promise<void>;
    private instanceMessageQueue_ :string[];  // List of recipient clientIDs.
    private remember :boolean;

    private SaveKeys = {
      ME: 'me'
    }
    private monitorIntervalId_ = null;

    /**
     * Initialize the social provider for this Network, and attach event
     * handlers.
     */
    constructor(public name:string) {
      this.provider = freedom[PREFIX + name];
      this.metadata = this.provider.manifest;
      this.remember = false;
      this.roster = {};
      this.onceLoggedIn_ = null;
      this.instanceMessageQueue_ = [];
      this.api = this.provider();
      // TODO: Update these event name-strings when freedom updates to
      // typescript and Enums.
      this.api.on('onUserProfile', this.delayForLogin(this.handleUserProfile));
      this.api.on('onClientState', this.delayForLogin(this.handleClientState));
      this.api.on('onMessage',     this.delayForLogin(this.handleMessage));
      // Begin loading everything relevant to this Network from local storage.
      this.syncFromStorage().then(() => {
        this.log('prepared Social.Network.');
        this.notifyUI();
      });
    }

    /**
     * Obtain the prefix for all storage keys associated with this Network.
     */
    public getStorePath = () => {
      return this.name + '/';
    }

    /**
     * Wrapper around logging-in to the social-provider. Updates the local
     * client information, and send an update to the UI upon success. Does
     * nothing if already logged on.
     */
    public login = (remember:boolean = false) : Promise<void> => {
      if (this.isLoginPending()) {
        // Login is already pending, reject promise so the caller knows
        // this request to login failed (the pending request may still succeed).
        console.warn('Login already pending for ' + this.name);
        return Promise.reject();
      } else if (this.isOnline()) {
        console.warn('Already logged in to ' + this.name);
        return Promise.resolve();
      }

      var request :freedom.Social.LoginRequest = {
        agent: 'uproxy',
        version: '0.1',
        url: 'https://github.com/uProxy/uProxy',
        interactive: true,
        rememberLogin: remember
      };
      this.onceLoggedIn_ = this.api.login(request)
          .then((freedomClient :freedom.Social.ClientState) => {
            // Upon successful login, save local client information.
            this.myInstance.userId = freedomClient.userId;
            this.startMonitor_();
            this.log('logged into uProxy');
          });
      return this.onceLoggedIn_
          .then(this.notifyUI)
          .catch(() => {
            this.onceLoggedIn_ = null;
            this.error('Could not login.');
            return Promise.reject(new Error('Could not login.'));
          });
    }

    /**
     * Wrapper around logging-out of the social provider. Does nothing if
     * already logged-out.
     */
    public logout = () : Promise<void> => {
      if (!this.isOnline()) {
        console.warn('Already logged out of ' + this.name);
        return Promise.resolve();
      }
      this.onceLoggedIn_ = null;
      this.stopMonitor_();
      return this.api.logout().then(() => {
        this.myInstance.userId = null;
        this.log('logged out.');
      }).then(this.notifyUI);
    }

    public isOnline = () : boolean => {
      // this.myInstance.userId is only set when the social API's login
      // promise fulfills.
      return Boolean(this.myInstance && this.myInstance.userId);
    }

    // Returns true iff a login is pending (e.g. waiting on user's password).
    public isLoginPending = () : boolean => {
      // We are in a pending login state if the onceLoggedIn_ promise is
      // defined, but we don't yet have the myInstance.userId set.
      return Boolean(this.onceLoggedIn_) && !this.isOnline();
    }

    /**
     * Functor which delays until the network is logged on.
     * Resulting function will instantly fail if not already in the process of
     * logging in.
     * TODO: This should either be factored into a wrapper class to 'sanitize'
     * social providers async behavior, or directly into freedom.
     */
    private delayForLogin = (handler :Function) => {
      return (arg :any) => {
        if (!this.onceLoggedIn_) {
          this.error('Not logged in.');
          return;
        }
        return this.onceLoggedIn_.then(() => {
          handler(arg);
        });
      }
    }

    /**
     * Check local storage for saved state about this Social.Network. If there
     * exists actual state, load everything into memory. Otherwise, initialize
     * to sane defaults.
     */
    public syncFromStorage = () : Promise<void> => {
      var preparedMyself = this.prepareLocalInstance();
      var preparedRoster = storage.load<SerialNetwork>(this.getStorePath())
          .then((json) => {
        this.log('loading previous state.');
        this.deserialize(json);
      }).catch((e) => {
        this.log('freshly initialized.');
      });
      return Promise.all([preparedMyself, preparedRoster]);
    }

    /**
     * Returns the local instance. If it doesn't exist, load local instance
     * from storage, or create a new one if this is the first time this uProxy
     * installation, on this device, has interacted with this network.
     */
    public prepareLocalInstance = () : Promise<void> => {
      if (this.myInstance) {
        return Promise.resolve();
      }
      var key = this.getStorePath() + this.SaveKeys.ME;
      return storage.load<Instance>(key).then((result :Instance) => {
        console.log(JSON.stringify(result));
        this.myInstance = new Core.LocalInstance(this, result);
        this.log('loaded local instance from storage: ' +
                 this.myInstance.instanceId);
        return this.myInstance;
      }, (e) => {
        this.myInstance = new Core.LocalInstance(this);
        this.log('generated new local instance: ' +
                 this.myInstance.instanceId);
        return storage.save<Instance>(key, this.myInstance.serialize()).then((prev) => {
          this.log('saved new local instance to storage');
          return this.myInstance;
        });
      });
    }

    public getLocalInstance = () : Core.LocalInstance => {
      return this.myInstance;
    }

    /**
     * Helper which tells the UI about the existence / status of this network.
     * This should only be called upon logging in/out. It does not tell the UI
     * about the roster.
     */
    public notifyUI = () => {
      var payload :UI.NetworkMessage = {
        name: this.name,
        online: this.isOnline()
      }
      ui.update(uProxy.Update.NETWORK, payload);
    }

    /**
     * Handler for receiving 'onUserProfile' messages. First, determines whether
     * the UserProfile belongs to ourselves or a remote contact. Then,
     * updates / adds the user data to the roster.
     *
     * NOTE: Our own 'Instance Handshake' is specific to this particular
     * network, and can only be prepared after receiving our own vcard for the
     * first time.
     * TODO: Check if the above statement on vcard is actually true.
     */
    public handleUserProfile = (profile :freedom.Social.UserProfile) => {
      var userId = profile.userId;
      // Check if this is ourself, in which case we update our own info.
      if (userId == this.myInstance.userId) {
        // TODO: we may want to verify that our status is ONLINE before
        // sending out any instance messages.
        this.log('<-- XMPP(self) [' + profile.name + ']\n' + profile);
        // Send our own InstanceMessage to any queued-up clients.
        this.flushQueuedInstanceMessages();
        // Update UI with own information.
        ui.update(uProxy.Update.USER_SELF, <UI.UserMessage>{
          network: this.name,
          user:    profile
        });
        return;
      }
      // Otherwise, this is a remote contact. Add them to the roster if
      // necessary, and update their profile.
      this.log('<--- XMPP(friend) [' + profile.name + ']' + profile);
      if (!(userId in this.roster)) {
        this.addUser_(userId);
      }
      this.getUser(userId).update(profile);
    }

    /**
     * Handler for receiving 'onClientState' messages. Passes these messages to
     * the relevant user, which will manage its own clients.
     *
     * It is possible that the roster entry does not yet exist for a user,
     * yet we receive a client state from them. In this case, create a
     * place-holder user until we receive more user information.
     *
     * Assumes we are in fact fully logged in.
     */
    public handleClientState = (freedomClient :freedom.Social.ClientState)
        : void => {
      var client :UProxyClient.State =
        freedomClientToUproxyClient(freedomClient);
      if (client.userId == this.myInstance.userId) {
        // TODO: Should we do anything in particular for our own client?
        this.log('received own ClientState: ' + JSON.stringify(client));
        return;
      }
      if (this.isNewFriend_(client.userId)) {
        this.log('received ClientState for ' + client.userId +
                 ' before UserProfile.');
        this.addUser_(client.userId);
      }
      this.getUser(client.userId).handleClient(client);
    }

    /**
     * When receiving a message from a social provider, delegate it to the
     * correct user, which will delegate to the correct client.
     *
     * It is possible that the roster entry does not yet exist for a user,
     * yet we receive a message from them. In this case, create a place-holder
     * user until we receive more user information.
     */
    public handleMessage = (incoming :freedom.Social.IncomingMessage)
        : void => {
      var userId = incoming.from.userId;
      if (this.isNewFriend_(userId)) {
        this.log('received Message for ' + userId + ' before UserProfile.');
        this.addUser_(userId);
      }
      var msg :uProxy.Message = JSON.parse(incoming.message);
      this.log('received <------ ' + incoming.message);
      this.getUser(userId).handleMessage(incoming.from.clientId, msg);
    }

    /**
     * Sometimes Network receives messages or ClientStates for userIds for which
     * we've yet to receive a UserProfile. In any case, we can begin with an
     * inital user.
     *
     * Assumes that |userId| is in fact a new user. (There will be a problem if
     * it overwrites an existing user in the roster.)
     */
    private addUser_ = (userId :string) => {
      if (!this.isNewFriend_(userId)) {
        this.error(this.name + ': cannot add already existing user!');
        return;
      }
      this.log('added "' + userId + '" to roster.');
      this.roster[userId] = new Core.User(this, userId);
      // Remember the new user.
      this.saveToStorage();
    }

    /**
     * Helper to determine if |userId| is a "new friend" to be adde to the
     * roster, and also isn't just our own userId, since we can receive XMPP
     * messages for ourself too.
     */
    private isNewFriend_ = (userId:string) : boolean => {
      return !(userId == this.myInstance.userId) &&
             !(userId in this.roster);
    }

    /**
     * Returns the User corresponding to |userId|.
     */
    public getUser = (userId :string) : Core.User => {
      return this.roster[userId];
    }

    /**
     * Helper which returns the local user's instance ID on this network.
     */
    public getLocalInstanceId = () : string => {
      return this.myInstance.instanceId;
    }

    /**
     * Generate my instance message, to send to other uProxy installations, to
     * inform them that we're also a uProxy installation to interact with.
     */
    private getInstanceHandshake_ = () : uProxy.Message => {
      if (!this.myInstance) {
        throw Error('No local instance available!');
      }
      // TODO: Should we memoize the instance handshake, or calculate it fresh
      // each time?
      return {
        type: uProxy.MessageType.INSTANCE,
        data: this.myInstance.getInstanceHandshake()
      }
    }

    /**
     * Notify remote uProxy installation that we are also a uProxy installation.
     *
     * Sends this network's instance handshake to a target clientId.
     * Assumes that clientId is ONLINE.
     *
     * NOTE: This is one of the few cases where we send a Message directly to a
     * |clientId| rather than |instanceId|. This is because there is not yet a
     * known instanceId, and also because this is internal to Social.Network
     * mechanics.
     */
    public sendInstanceHandshake = (clientId:string) : Promise<void> => {
      return this.sendInstanceHandshakes_([clientId]);
    }

    /**
     * Often times, network will receive client IDs belonging to remote
     * contacts known to be uProxy-enabled. This may happen prior to receiving
     * the local vcard, which is required for constructing the local Instance
     * Message. In this case, those instance messages must be queued.
     */
    public flushQueuedInstanceMessages = () => {
      if (0 === this.instanceMessageQueue_.length) {
        return Promise.resolve();  // Don't need to do anything.
      }
      return this.sendInstanceHandshakes_(this.instanceMessageQueue_)
          .then(() => {
            this.instanceMessageQueue_ = [];
          });
    }

    /**
     * Helper which sends our instance handshake to a list of clients, returning
     * a promise that all handshaks have been sent.
     */
    private sendInstanceHandshakes_ = (clientIds:string[]) : Promise<void> => {
      var handshakes :Promise<void>[] = [];
      var handshake = this.getInstanceHandshake_();
      var cnt = clientIds.length;
      if (!handshake) {
        throw Error('Not ready to send handshake');
      }
      clientIds.forEach((clientId:string) => {
        handshakes.push(this.send(clientId, handshake));
      })
      return Promise.all(handshakes).then(() => {
        this.log('sent ' + cnt + ' instance handshake(s): ' +
                 clientIds.join(', '));
      });
    }

    /**
     * Send a message to a remote client.
     *
     * Assumes that |clientId| is valid. Social.Network does not manually manage
     * lists of clients or instances. (That is handled in user.ts, which calls
     * Network.send after doing the validation checks itself.)
     *
     * Still, it is expected that if there is a problem, such as the clientId
     * being invalid / offline, the promise returned from the social provider
     * will reject.
     */
    public send = (clientId:string, msg:uProxy.Message) : Promise<void> => {
      var msgString = JSON.stringify(msg);
      this.log('sending ------> ' + msgString);
      return this.api.sendMessage(clientId, msgString);
    }

    /**
     * Serialize information about this network to be saved to storage or sent
     * to UI. This excludes the local instance information, which is
     * saved/loaded separately.
     */
    public serialize = () : SerialNetwork => {
      return {
        name: this.name,
        remember: false,
        // Only save and load the userIds in the roster.
        // The actual Users will be saved and loaded separately.
        userIds: Object.keys(this.roster)
      }
    }
    public deserialize = (json :SerialNetwork) => {
      if (this.name !== json.name) {
        throw Error('Loading unexpected network name!' + json.name);
      }
      this.remember = json.remember;
      // Load all users based on userIds.
      for (var i = 0 ; i < json.userIds.length ; ++i) {
        this.loadUserFromStorage_(json.userIds[i]);
      }
    }
    private loadUserFromStorage_ = (userId :string) => {
      storage.load<Core.SerialUser>(this.getStorePath() + userId)
          .then((json) => {
        this.roster[userId] = new Core.User(this, userId);
        this.roster[userId].deserialize(json);
        this.log('successfully loaded user ' + userId);
      }).catch((e) => {
        this.error('could not load user ' + userId);
      });
    }
    private saveToStorage = () => {
      var json = this.serialize();
      storage.save<SerialNetwork>(this.getStorePath(), json)
          .then((old) => {
        this.log('saved to storage. ' + JSON.stringify(json));
      }).catch((e) => {
        console.error('failed to save to storage', e);
      });
    }

    /**
     * Helper which logs messages clearly belonging to this Social.Network.
     */
    private log = (msg:string) : void => {
      console.log('[' + this.name + '] ' + msg);
    }

    private error = (msg:string) : void => {
      console.error('!!! [' + this.name + '] ' + msg);
    }

    private startMonitor_ = () : void => {
      if (this.monitorIntervalId_) {
        // clear any existing monitor
        console.warn('startMonitor_ called with monitor already running');
        this.stopMonitor_();
      }

      var monitorCallback = () => {
        this.log('Running monitor');
        // TODO: if too many instances are missing, we may send more messages
        // than our XMPP server will allow and be throttled.  We should change
        // monitoring to limit the number of XMPP messages it sends on each
        // interval.
        for (var userId in this.roster) {
          this.getUser(userId).monitor();
        }
      };
      setInterval(monitorCallback, 5000);
    }

    private stopMonitor_ = () : void => {
      if (this.monitorIntervalId_) {
        clearInterval(this.monitorIntervalId_);
      }
    }

  }  // class Social.Network

  // TODO: rename `SerializedNetwork`.
  export interface SerialNetwork {
    name     :string;
    remember :boolean;
    userIds  :string[];
  }

}  // module Social

function freedomClientToUproxyClient(
  freedomClientState :freedom.Social.ClientState) : UProxyClient.State {
  // Convert status from Freedom style enum value ({'ONLINE': 'ONLINE',
  // 'OFFLINE: 'OFFLINE'}) to TypeScript style {'ONLINE': 4000, 4000: 'ONLINE',
  // 'OFFLINE': 4001, 4001: 'OFFLINE'} value.
  return {
    userId:    freedomClientState.userId,
    clientId:  freedomClientState.clientId,
    status:    UProxyClient.Status[freedomClientState.status],
    timestamp: freedomClientState.timestamp
  };
}
