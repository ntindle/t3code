import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  SECRET_REQUEST_PRIVACY_NOTE,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import { withUniwind } from "uniwind";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

/**
 * Feed card for a secret an agent asked the user for. The typed value lives
 * only in this component's state and the RPC payload: it is never logged,
 * alerted, or persisted, and the field clears once the answer is sent.
 */
const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };
const PRIVATE_SYMBOL: AppSymbolName = { ios: "checkmark.shield", android: "lock" };
const PASTE_SYMBOL: AppSymbolName = { ios: "doc.on.clipboard", android: "content_paste" };

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "secret_request") return null;
  const display = secretRequestDisplay(item, visibility);
  if (display.kind === "pending") {
    return (
      <PendingSecretRequestForm
        environmentId={props.environmentId}
        item={item}
        iconColor={props.iconColor}
      />
    );
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere"
      ? LOCK_SYMBOL
      : display.outcome === "saved"
        ? "checkmark"
        : "minus";
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {item.label} · {display.label}
      </Text>
    </View>
  );
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly iconColor: ColorValue;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (
    reply: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    // Empty the field before the card can leave the screen: iOS offers to save
    // whatever a password field holds when it goes, and this is not a login.
    const typed = secret;
    setSecret("");
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    // On success the card switches to its answered row once the item updates.
    if (result._tag === "Success") return;
    setSecret(typed);
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  const paste = (text: string) => {
    if (inFlight.current || text.length === 0) return;
    setSecret(text);
    setError(null);
  };

  // Same hierarchy as web: what is asked, why, the field, then the promise
  // about where the value goes.
  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">{item.label}</Text>
        {item.reason.trim() ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">{item.reason}</Text>
        ) : null}
      </View>
      <View className="justify-center">
        <TextInput
          className="pr-14"
          accessibilityLabel={item.label}
          placeholder={item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
          value={secret}
          onChangeText={setSecret}
          editable={!submitting}
          secureTextEntry
          autoCorrect={false}
          autoCapitalize="none"
          // iOS reads only textContentType; as a password field it offers saved
          // passwords above the keyboard. Android reads autoComplete and
          // importantForAutofill, which keep its autofill off.
          autoComplete="off"
          textContentType="password"
          importantForAutofill="no"
          spellCheck={false}
          returnKeyType="done"
          onSubmitEditing={() => void send({ type: "save", secret })}
        />
        <SecretPasteButton
          disabled={submitting}
          onPaste={paste}
          onError={() => setError("Could not read the clipboard.")}
        />
      </View>
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <RequestActionButton
        label="Save securely"
        disabled={submitting || secret.trim().length === 0}
        onPress={() => void send({ type: "save", secret })}
      />
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1 flex-row items-center gap-1.5">
          <SymbolView
            name={PRIVATE_SYMBOL}
            size={13}
            tintColor={props.iconColor}
            type="monochrome"
          />
          <Text className="flex-1 font-sans text-xs text-foreground-muted">
            {SECRET_REQUEST_PRIVACY_NOTE}
          </Text>
        </View>
        {/* Quiet like the web card's: the field and Save are the action. */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: submitting }}
          disabled={submitting}
          hitSlop={8}
          className="px-1 py-1 active:opacity-60 disabled:opacity-50"
          onPress={() => void send({ type: "decline" })}
        >
          <Text className="font-sans text-xs text-foreground-muted">Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}

const ThemedClipboardPasteButton = withUniwind(Clipboard.ClipboardPasteButton);

/**
 * Paste button inside the field's trailing edge. On iOS it is the system paste
 * control, which reads the clipboard without the paste permission alert.
 */
function SecretPasteButton(props: {
  readonly disabled: boolean;
  readonly onPaste: (text: string) => void;
  readonly onError: () => void;
}) {
  return (
    <View className="absolute inset-y-0 right-1.5 justify-center">
      {Clipboard.isPasteButtonAvailable ? (
        // UIPasteControl draws nothing without an explicit size.
        <ThemedClipboardPasteButton
          className="size-10"
          acceptedContentTypes={["plain-text"]}
          displayMode="iconOnly"
          backgroundColorClassName="accent-input"
          foregroundColorClassName="accent-icon"
          onPress={(data) => {
            if (data.type === "text") props.onPaste(data.text);
          }}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Paste"
          accessibilityState={{ disabled: props.disabled }}
          disabled={props.disabled}
          className="size-10 items-center justify-center rounded-full active:opacity-60 disabled:opacity-50"
          onPress={() => void Clipboard.getStringAsync().then(props.onPaste, props.onError)}
        >
          <SymbolView
            name={PASTE_SYMBOL}
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        </Pressable>
      )}
    </View>
  );
}
