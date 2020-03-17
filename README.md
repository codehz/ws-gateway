# ws-gateway
WebSocket API gateway built using deno

## Draft Spec

Messages are encoded as MessagePack

### Service side

#### Send

**Handshake packet**

1. `str "WS-GATEWAY"` 
2. `int 0` as protocol version
3. `str (service name)` 
4. `str (service type)` 
5. `str (service version string)` 

**Response packet**

1. `int 0` as Response
2. `int (request id)` as Request id
3. data

**Broadcast packet**

1. `int 1` as Broadcast
2. `str key` as Broadcast key
3. data

#### Receive

**Request packet**

1. `int 0` as Request
2. `str (key)` as method key
3. `int (id)` as request id
4. data

**CancelRequest packet**

(optional, can be ignored)

1. `int 1` as CancelRequest
2. `str (key)` as method key
3. `int (id)` as request id

### Client side

#### Send

**Handshake packet**

1. `str "WS-GATEWAY-CLIENT"` as magic
2. `int 0` as protocol version

**GetServiceList packet**

1. `int 0` as GetServiceList

*sync response*

1. `int 0` as Sync
2. `map<str (service name), array [str (type), str (version)]>`

**WaitService packet**

1. `int 1` as WaitService
2. `str (name)` as service name

*sync response*

1. `int 0` as Sync
2. `bool (online status)`

*async response*

1. `int 3` as Wait
2. `str (name)` as target service name
3. `bool (online status)`

**CallService packet**

1. `int 2` as CallService
2. `str (name)` as service name
3. `str (key)` as method key
4. data

*sync response*

1. `int 0` as Sync
2. `bool (success)`
3. `int (request id)` if success

*async response 1: success*

1. `int 1` as Response
2. `str (service name)`
3. `int (request id)`
4. data

*async response 2: cancel*

1. `int 4` as CancelRequest
2. `str (service name)`
3. `int (request id)`

**SubscribeService packet**

1. `int 3` as SubscribeService
2. `str (name)` as service name
3. `str (key)` as event key

*sync response*

1. `int 0` as Sync
2. `bool (success)`

**async response: success**

1. `int 2` as Broadcast
2. `str (name)` as service name
3. `str (key)` as event key
4. data

**async response: cancel**

1. `int 5` as CancelSubscribe
2. `str (name)` as service name
3. `str (key)` as event key