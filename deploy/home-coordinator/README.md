# QuayMesh home-hosted Coordinator

The identity `cloud` and its public EasyTier address `10.144.144.254` remain stable.
The Coordinator process, registry, OAuth state and SQLite data live on the Home
Gateway's local ext4 volume. Alibaba Cloud keeps only the independent EasyTier
rendezvous service and these three TCP socket-proxy units.

| Cloud endpoint | Home Gateway destination |
| --- | --- |
| 10.144.144.254:7676 (MCP / Console) | 10.144.144.3:27676 |
| 10.144.144.254:7680 (Federation) | 10.144.144.3:27680 |
| 10.144.144.254:7681 (Registry) | 10.144.144.3:27681 |

The Home Gateway retains its separate `home-gateway` worker and discovery
process on the original ports. The dedicated `quaymesh-coordinator.service`
must have `id=cloud`, `mesh.enabled=false`, `mesh.address=10.144.144.254`,
`corePort=27676`, `peerPort=27680`, `registryPort=27681`,
`adminPort=27677`, and `network.externalAccess=false`. Its state and
SQLite database belong to a separate directory on Home, never to a network
filesystem.

Cloud socket units are installed to `/etc/systemd/system/` and started
only after the original Cloud Coordinator has stopped and its final SQLite
snapshot has been copied. Enable the three socket units `@7676`, `@7680`,
`@7681`, and enable the Home Coordinator service after validating the
complete dataset. Do not enable simultaneous Coordinators with identity
`cloud`: doing so would create split-brain task and OAuth state.

The transition uses an explicitly started one-time Home activation process
(`home-activate.sh`) and a Cloud-side cutover process (`cloud-cutover.sh`).
The latter writes a final SQLite backup after the old Core stops, copies it
over the authenticated EasyTier mesh, verifies the copy, then sends an
activation marker. Home starts the new Coordinator only after checking its
database. Cloud enables TCP forwarding only after Home is ready and waits
for all five nodes to register before committing. The Home activation
process enables boot persistence only after the commit marker arrives.
Staging artifacts are kept on Home for audit; stop the temporary rsync
import service after completion.

To roll back before accepting new work, stop all three proxy sockets and
their services, stop the Home Coordinator, and restart the original Cloud
`quaymesh-node.service`. After new work has been accepted on Home, copy
the newest Home database back before any rollback to prevent data loss.

Neither the Cloud proxy nor the Coordinator contacts Google/OpenAI directly.
The existing discovery nodes and their OAuth origin remain unchanged.
