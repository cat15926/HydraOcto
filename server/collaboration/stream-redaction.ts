// Withhold a possible credential prefix until the next fragment disambiguates it.
export function streamRedactor(secrets: string[]) {
  let pending = '';
  const keys = secrets.filter(Boolean).sort((a,b)=>b.length-a.length);
  return (fragment: string) => {
    let value = pending + fragment;
    for (const key of keys) value = value.split(key).join('[redacted]');
    let tail = 0;
    for (const key of keys) {
      for (let n=Math.min(key.length-1,value.length); n>tail; n--) {
        if (value.endsWith(key.slice(0,n))) { tail=n; break; }
      }
    }
    pending = value.slice(value.length-tail);
    return value.slice(0,value.length-tail);
  };
}
