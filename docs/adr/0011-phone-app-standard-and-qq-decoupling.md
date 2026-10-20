# Decouple QQ and standardize virtual phone apps

The Character originally interacted with QQ directly through phone-level actions (`view_contacts`, `open_chat`, `send_messages`, `wait_messages`), coupling the phone state machine and the Simulation Agent to a single chat platform. We decoupled QQ into a virtual `PhoneApp` running inside the phone alongside future apps, refactored the phone Home state into three distinct areas (Top Notification, Home Notification Area, and App Area), unified physical alerts into three Phone-managed Notification Signals (`vibration`, `ring`, and `special_ring`), and restricted QQ-specific actions to when the Character has opened the QQ app.

## Considered Options

- **Register each Phone App as a separate Agent Tool**: would require multiple public tools on the Simulation Agent, breaking the terminating-action invariant checking and Action Menu appendix architecture established in ADR-0006 and ADR-0007.
- **Keep QQ hardcoded at phone level and add extra apps as exceptions**: would permanently tie MoonanBot's core state machine to OneBot v11 and prevent running the bot without an active QQ connection.
- **Unified PhoneApp interface with hierarchical Phone State (chosen)**: keeps the single `perform_action` entry point and dynamic Action Menu; allows MoonanBot to start, wake, and simulate even when QQ is offline; standardizes app lifecycle, navigation, and physical notification signals across all current and future virtual apps.
