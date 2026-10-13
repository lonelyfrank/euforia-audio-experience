# Transizioni fra ambienti e portali — studio

Data: 13 ottobre 2026. **Nulla di questo documento è implementato.** È lo studio chiesto insieme a
Generative Terrain: che cosa l'architettura permette già, che cosa manca per comporre ambienti
(`Generative World A → Infinite Tunnel → Generative World B`), e quale contratto servirebbe, con
ownership, sincronizzazione, lifecycle e rilascio delle risorse. Nessuna infrastruttura è stata
aggiunta per prepararlo.

## 1. Che cosa esiste già

| Capacità | Dove | Che cosa garantisce |
|---|---|---|
| Due scene in dissolvenza nello stesso slot | `RenderEngine.setSlot` (`current` / `previous`, `mix`) | il cambio di scena è già una transizione: la vecchia resta finché la nuova è pronta (`Layer.ready`), poi viene rilasciata |
| Fino a tre fixture composte | `SLOTS`, `ShowDirector`, `compositeShader` | protagonista + supporti, con peso, dimensione, offset e specchio per slot |
| Un solo mondo per tutte le scene | `ExperienceEngine.world` → `WorldView` per layer | una scena montata durante una dissolvenza eredita subito quantità di moto, pressione, potenziale ed eccitazione: **il moto non riparte** |
| Lo stesso viaggio | `WorldView.dTravel`, `RateFollower` | Tunnel e Terrain avanzano della stessa distanza del mondo: attraversare un confine non cambia velocità |
| Momenti musicali datati | `EventStream` (`drop`, `sectionBoundary`, `phraseBoundary`), `ExperiencePlan.transitionStart/End` | una transizione può essere agganciata al tempo audio di un evento, non al frame |
| Che cosa ci si aspetta | `ExperienceSnapshot.anticipation` | sapere se un'anticipazione è aperta, confermata o scaduta prima di impegnare un cambio d'ambiente |
| Chi decide i cambi | `ShowDirector` (sezione, frase, hold, budget GPU) | i look cambiano ai confini di sezione o di frase, mai a metà |
| Struttura che un rilascio lascia | `world/Reorganization.ts` | una scelta deterministica per rilascio, uguale a ogni frame rate |

Quindi `Terrain → Tunnel → Terrain` **è già esprimibile** come due dissolvenze nello slot 0, decise
dal regista ai confini musicali, con moto continuo. Quello che non esiste è il *portale*: un
passaggio **nello spazio** (l'imbocco del Tunnel che emerge dal terreno e viene attraversato), non
una dissolvenza a tutto schermo.

## 2. Che cosa manca per un portale

1. **Un'apertura nello spazio della composizione.** Oggi la composizione mescola layer interi con un
   peso. Un portale è una maschera: dentro una regione dello schermo si vede l'ambiente d'arrivo. Il
   posto naturale è il pass di composizione (`compositeShader`), che resta **uno solo**: un uniform in
   più per slot (centro, raggio, bordo), nessun pass aggiuntivo.
2. **Dove sta l'imbocco, detto dall'ambiente di partenza.** Solo la scena sa dove, nel proprio
   spazio, può aprirsi un passaggio (per il terreno: sul fondo valle, a una certa profondità lungo il
   percorso). Serve una lettura *opzionale* della scena, non una dipendenza fra scene.
3. **Un proprietario della transizione.** Né il Tunnel né il Terrain devono sapere dell'altro. Chi
   decide è chi già decide i cambi (`ShowDirector`); chi esegue è chi già monta le scene
   (`RigController` → `RenderEngine`).

## 3. Contratto proposto (non implementato)

```ts
/** Sulla scena, opzionale: dove un passaggio può aprirsi nel suo spazio. Sola lettura, nessuno stato musicale. */
interface PortalAnchor {
  /** Centro sullo schermo (0..1) e raggio (frazione dell'altezza) dell'imbocco, se fosse aperto del tutto. */
  x: number; y: number; radius: number;
  /** 0..1: quanto l'ambiente può offrire un imbocco adesso (0 = nessuno: la transizione ripiega sulla dissolvenza). */
  available: number;
}

/** Deciso dal ShowDirector, eseguito da RigController / RenderEngine: una transizione datata sul clock audio. */
interface EnvironmentTransition {
  from: string; via: string | null; to: string;   // id di scena del registry; `via` = l'ambiente di passaggio
  /** Tempo audio in cui l'imbocco comincia ad aprirsi e in cui è attraversato (di norma un confine di frase previsto). */
  openAt: number; crossAt: number;
  /** Perché: l'evento o la previsione che la giustifica, per il log delle decisioni. */
  why: string;
}
```

| Aspetto | Regola |
|---|---|
| **Ownership** | `ShowDirector` decide (una decisione di sezione, registrata nel suo log con il perché); `RigController` monta gli ambienti negli slot; `RenderEngine` anima l'apertura nel pass di composizione; la scena di partenza dà solo `PortalAnchor`. Nessuna scena importa un'altra scena. |
| **Sincronizzazione** | Tutto sul **clock udito**: apertura = funzione di `heardTime − openAt`, come ogni cosa che parte da un evento; uguale a ogni frame rate. Il viaggio è del mondo: nessuna velocità propria della transizione. |
| **Conferma** | Si apre solo con un'anticipazione `probable` e una previsione di confine credibile (`plan.transitionConfidence`); se l'anticipazione **scade**, l'imbocco si richiude con la stessa rampa e l'ambiente d'arrivo viene rilasciato: è il recupero da falsa previsione, senza salti. |
| **Lifecycle** | L'ambiente d'arrivo è montato quando l'apertura comincia (compila i programmi mentre è ancora invisibile: `Layer.ready`); quello di partenza è rilasciato quando l'apertura è completa, come oggi alla fine di una dissolvenza. |
| **Risorse** | Mai più di due ambienti vivi nello slot (com'è oggi); il costo passa da `GpuBudget` come quello di un supporto: senza margine, niente portale (resta la dissolvenza). |
| **Reset** | Una nuova sessione audio annulla la transizione in corso (lo slot torna alla scena scelta). |

## 4. Confini da non oltrepassare

- **Nessuno scene manager parallelo**: slot, layer e dissolvenze esistono; un portale è un modo in
  più di passare da `previous` a `current`, non un secondo sistema.
- **Nessun editor di mondi, livelli o gameplay**: una transizione è una decisione di regia, datata
  sulla musica.
- **Il Tunnel non cambia**: come passaggio è il Tunnel com'è, montato per la durata che il regista
  decide. Nessun parametro «modalità portale» nella scena.
- **Niente geometria condivisa fra ambienti**: l'imbocco è una maschera di composizione; l'illusione
  di continuità viene dal mondo condiviso (stessa corsa, stessa luce, stesso rilascio).

## 5. Ordine consigliato, quando verrà autorizzato

1. `PortalAnchor` sul terreno (dove il fondo valle incontra l'orizzonte) e maschera nel pass di
   composizione, dietro un interruttore DEV; nessuna decisione automatica.
2. Una prova manuale dal workspace (laboratorio): apri / attraversa / annulla su un segnale
   sintetico, con misura del costo del secondo ambiente montato.
3. Solo dopo il giudizio a occhio con musica reale: la decisione nel `ShowDirector` e il recupero
   dalla previsione scaduta.
