# Execution lifecycle

[Home](../README.md) · [Tasks](TASKS.md) · [File changes](execution-resources.md)

QuayMesh associates accepted work with persistent task and operation IDs. Commands, file transfers, and agent actions retain their own state and output.

Long commands return an operation ID while execution continues. Clients read additional output with a byte cursor, and repeated submissions can reuse an operation key.

Nodes retain their applied configuration and report component state independently. Installation places a new release in its own directory before changing the service.

The console keeps received data visible while refreshing it and reports node connection state. Task history preserves the files and results recorded for that task.

See [installation](INSTALL.md) for service and recovery commands.
