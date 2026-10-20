type Listener = () => void;

const listeners = new Set<Listener>();
const remeasurers = new Set<Listener>();

// Shared between the scroll effects (Field) and the headline wheel.
export const fxStore = {
  obscured: false,
  setObscured(value: boolean) {
    if (value === fxStore.obscured) return;
    fxStore.obscured = value;
    listeners.forEach((l) => l());
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  onRemeasure(l: Listener) {
    remeasurers.add(l);
    return () => void remeasurers.delete(l);
  },
  remeasure() {
    remeasurers.forEach((l) => l());
  },
};
