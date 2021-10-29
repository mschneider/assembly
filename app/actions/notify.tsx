import useNotificationStore from "../stores/useNotificationsStore";

export function notify(newNotification: {
  type?: string;
  message: string;
  description?: string;
  txid?: string;
}) {
  const { notifications, set: setNotificationStore } =
    useNotificationStore.getState();

  console.info("notify", newNotification);

  setNotificationStore((state) => {
    state.notifications = [
      ...notifications,
      { type: "success", ...newNotification },
    ];
  });
}
