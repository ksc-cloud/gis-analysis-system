# 격자 렌더링 벤치마크 (8-6B-1A)

VWorld 3D 지도에서 `vw.geom.PolygonZ`로 격자 셀을 많이 만들 때의 성능을 재는 **개발용 도구**입니다.
8-6B 격자 밀집도 지도 표시를 구현하기 전에, 50 m 격자(반경 1 km에서 최대 1,345셀)를 기존 방식으로 그릴 수 있는지
판단하기 위한 측정값을 모읍니다.

- 앱 소스(`src/main`)에는 포함되지 않으며 서버가 제공하지 않습니다. 브라우저 개발자 도구 콘솔에서만 실행합니다.
- 앱 코드, Java·Python API, DB를 바꾸지 않습니다.
- 결과는 브라우저 콘솔에만 남습니다. 서버나 외부로 전송하지 않습니다.
- **자동 테스트(`grid-bench.test.js`)는 도구의 계산과 정리 동작만 검사합니다. VWorld 성능은 실제 브라우저에서
  측정해야만 알 수 있습니다.**

## 준비

| 필요 | 설명 |
|---|---|
| Java 서버(8080) | 유효한 VWorld API 키가 설정되어 지도가 표시되어야 합니다. (키의 등록 URL과 접속 주소 일치) |
| 브라우저 | WebGL 하드웨어 가속이 켜진 최신 Chrome 또는 Edge 권장. 메모리(`performance.memory`)와 긴 작업 측정은 Chromium 계열에서만 됩니다. |
| Python 서버(8001) | 합성 격자 측정에는 필요 없습니다. 실제 `grid-density` 응답으로 측정할 때만 필요합니다. |

측정 환경은 결과 JSON의 `environment`에 자동으로 들어갑니다(브라우저, OS, 화면 해상도, 3D 건물 레이어 켜짐 여부).
**CPU·GPU 모델은 브라우저가 알려 주지 않으므로 보고할 때 직접 적어 주세요.**

## 실행 방법

1. 앱(`http://localhost:8080`)을 열고 3D 지도가 표시될 때까지 기다립니다.
2. (선택) 측정할 위치에서 반경 분석을 한 번 실행합니다. 분석 중심이 있으면 그 주변에, 없으면 서울특별시청 주변에 격자를 만듭니다.
3. 개발자 도구(F12) → Console에서 `tools/grid-bench/grid-bench.js` 내용을 모두 붙여 넣고 Enter를 누릅니다.
   (Sources → Snippets에 저장해 두고 실행해도 됩니다.) `[grid-bench] 준비됨` 메시지가 나오면 됩니다.
4. 측정을 실행합니다.

```js
// 짧은 확인 (약 수십 초)
await gridBench.run({ counts: [100, 300], methods: ['A', 'D'], repeats: 1, memoryCycles: 2 });

// 기본 측정: 100 / 300 / 500 / 1,000 / 1,345셀 × A·D × 3회 + 메모리 반복 5회
await gridBench.run();

// 결과 JSON을 클립보드로 복사 (DevTools 콘솔의 copy 함수)
copy(gridBench.json());
```

기본 측정은 정해진 대기 시간만으로도 실행 30번 × (정지 2초 + 카메라 이동 7.5초)가 걸리므로(약 285초) **최소 약 5분**
걸립니다. 실제 시간은 도형 생성 속도에 따라 더 길어집니다. 실행하는 동안에는 지도를 조작하지 마세요(카메라 이동 측정이
지도를 자동으로 움직입니다).

3D 건물 레이어 켜짐·꺼짐을 비교하려면 사이드바 "레이어"에서 "3D 건물"을 바꾼 뒤 다시 `gridBench.run()`을 실행하세요.

### 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `counts` | `[100, 300, 500, 1000, 1345]` | 셀 수 |
| `methods` | `['A', 'D']` | A: 한 번에 생성, D: `requestAnimationFrame`으로 나누어 생성 |
| `repeats` | `3` | 셀 수·방식마다 반복 횟수 |
| `warmup` | `true` | 결과에 넣지 않는 예열 실행 1회 |
| `chunkSize` | `100` | D 방식에서 프레임당 생성 수 |
| `idleSampleMs` | `2000` | 생성 후 정지 상태 프레임 측정 시간 |
| `camera` | `true` | 카메라 이동 중 프레임 측정 (`map.moveTo`로 5개 위치 이동) |
| `cameraStepMs` | `1500` | 카메라 위치마다 머무는 시간 |
| `memoryCycles` | `5` | 가장 큰 셀 수로 생성·삭제를 반복하며 힙 기록 (2 미만이면 생략) |
| `cellSize`, `inset` | `50`, `0.02` | 셀 크기(m), 셀 사이 틈 비율 (지면 도형에 외곽선이 없어 틈으로 격자선을 표현) |
| `center` | 분석 중심 또는 시청 | `{ lon, lat }` |
| `cells` | 없음 | 실제 격자 셀 (아래 "실제 격자로 측정") |

### 클릭 반응 시간

```js
// "건물 선택" 또는 "좌표 조회" 모드에서 실행 (반경 분석 모드는 클릭이 중심점을 바꾸므로 거부됩니다)
await gridBench.measureClicks({ cells: 1345, samples: 10 });
// 콘솔 안내가 나오면 지도 위 격자 셀을 10번 클릭합니다. 60초가 지나면 그때까지의 값으로 끝납니다.
copy(gridBench.json());
```

"건물 선택" 모드에서는 셀을 클릭하면 앱이 건물 선택을 해제할 수 있습니다(앱의 기존 동작). 측정에는 영향이 없습니다.

### 실제 격자로 측정 (선택, Python 필요)

도구는 서버를 호출하지 않습니다. 필요하면 콘솔에서 직접 앱의 Java API로 받은 응답을 넘깁니다.

```js
// 반경 분석 직후 저장 전 결과: 토큰은 반경 분석 응답의 analysisToken
const body = await (await fetch('/api/analysis-snapshots/<token>/grid-density?cellSize=50')).json();
const cells = gridBench.cellsFromGridDensity(body, { excludeEmpty: true });   // 빈 격자 제외(방식 C)
await gridBench.run({ cells, counts: [cells.length], methods: ['A', 'D'] });
```

### 취소와 정리

```js
gridBench.cancel();   // 실행 중 취소: 남은 단계를 건너뛰고 status: "cancelled" 결과를 냅니다
gridBench.cleanup();  // 이 도구가 만든 도형·관찰자·리스너를 즉시 정리 (몇 번이고 호출 가능)
gridBench.status();   // { running, objects, observers, listeners }
gridBench.probe();    // vw.geom 등에 있는 생성자 목록 (다른 렌더링 방식 검토용, 읽기만 함)
```

- 이 도구는 **자기가 만든 도형만** 기록하고 지웁니다. 반경 분석 도형, 검색 마커, 측정 결과는 그대로이며
  `map.clear()`는 호출하지 않습니다.
- 동시에 하나만 실행됩니다. 실행 중에 다시 부르면 `ALREADY_RUNNING` 오류가 납니다.
- 오류가 나거나 취소되어도 만든 도형, `PerformanceObserver`, DOM 리스너, 예약된 프레임·타이머를 모두 정리합니다.
  탭이 백그라운드여서 프레임이 오지 않을 때도 취소와 정리는 끝까지 진행됩니다.
- 파일을 다시 붙여 넣으면 이전 인스턴스를 먼저 정리합니다.
- 카메라 이동 측정이 끝나면 카메라는 시작 위치(중심 상공 1,500 m)로 돌아갑니다. 측정 전 시점은 공개 API로 읽을 수 없어
  복원하지 않습니다.

## 결과 JSON

| 필드 | 내용 |
|---|---|
| `status` | `completed` / `cancelled` / `failed` (`error`에 이유) / `timeout`(클릭 측정) |
| `environment` | 브라우저와 버전, OS, 화면(`width`, `height`, `devicePixelRatio`), 창 크기, `hardwareConcurrency`, `deviceMemoryGb`, `buildings3d`(3D 건물 레이어, 알 수 없으면 `null`) |
| `options` | 셀 수, 방식, 반복, 중심점과 출처(`analysis` / `option` / `default`), 셀 출처(`synthetic` / `grid-density`) |
| `runs[]` | 실행 1건: `cells`, `method`, `repeat`, `create`(`ms`, `created`, `errors`, `chunks`, `maxChunkMs`), `longTasks`(`type`, `count`, `maxMs`, `totalMs`), `framesDuringCreate`, `firstFrameMs`, `framesIdle`, `framesCamera`, `restoreMs`, `deleteMs`, `deleteFailures`, `heap`(`before`, `afterCreate`, `afterDelete`), `cancelled` |
| 프레임 통계 | `frames`, `p50`, `p95`, `max`, `overThreshold`(50 ms 초과 프레임 수), `fps` |
| `memoryTrend` | `samples`(반복마다 삭제 후 힙), `slopeBytesPerCycle`, `increasingSteps`, `firstToLastBytes`. 지원하지 않으면 `{ supported: false }` |
| `summary[]` | 셀 수·방식별 중앙값: 생성, 첫 프레임, 정지·카메라 p95, 복원, 삭제, 가장 긴 작업 |
| `clicks` | 클릭 측정: `samplesMs`, `stats` |
| `limits` | 아래 측정 한계 |

측정하지 못한 값은 `null`입니다(추정값을 넣지 않음).

## 측정 한계

- `firstFrameMs`는 생성이 끝난 뒤 두 번째 `requestAnimationFrame`까지의 시간입니다. VWorld가 지면 도형을 비동기로 준비하면
  실제로 보이는 시각은 더 늦을 수 있으며, 공개 API로는 알 수 없습니다. 화면 녹화로 확인하세요.
- 프레임 간격은 `requestAnimationFrame` 콜백 간격이며 GPU 처리·화면 합성 지연을 포함하지 않을 수 있습니다.
- 긴 작업은 `PerformanceObserver`(`long-animation-frame` 또는 `longtask`)를 지원하는 브라우저에서만 측정합니다. 아니면 `null`입니다.
- 힙은 Chrome 전용 `performance.memory`의 JS 힙입니다. 기본 설정에서는 값이 양자화되고 GC를 강제할 수 없어 근삿값이며,
  GPU 메모리는 포함되지 않습니다. GPU 메모리는 Chrome 작업 관리자(Shift+Esc)의 "GPU 메모리"를 직접 기록하세요.
- 카메라 이동 측정은 `map.moveTo` 애니메이션 동안의 프레임입니다. 사람이 끄는 드래그와 다를 수 있으니 수동 드래그 느낌도 함께 적어 주세요.
- 클릭 반응은 지도 요소의 `pointerdown`부터 `PolygonZ` 클릭 콜백까지의 시간이며 이후 화면 갱신은 포함하지 않습니다.
- `restoreMs`는 앱의 `restore()`처럼 이 도구의 도형을 지우고 다시 만드는 시간입니다. 측정 초기화(`map.clear()`) 경로는 다른
  도형까지 지우므로 측정하지 않습니다.

## 참고 판단 기준 (초기값)

다음은 **확정된 성능 요구사항이 아니라**, 실제 측정 후 조정할 수 있는 초기 판단 기준입니다. 1,345셀 기준입니다.

| 항목 | 기준 | 결과 필드 |
|---|---|---|
| 생성 중 단일 긴 작업 | 200 ms 이하 | `summary[].longTaskMaxMs` (A는 생성 시간 전체가 한 작업일 수 있음) |
| 전체 생성 시간 | 3초 이하 | `summary[].createMsMedian` |
| 지도 이동 시 프레임 p95 | 50 ms 이하 | `summary[].cameraP95Median` |
| 삭제 시간 | 1초 이하 | `summary[].deleteMsMedian` |
| 클릭 반응 | 300 ms 이하 | `clicks.stats.p95` |
| 생성·삭제 반복 후 메모리 | 지속적인 증가 없음 | `memoryTrend.increasingSteps`, `slopeBytesPerCycle`, Chrome 작업 관리자 |

## 테스트 (도구 자체)

```powershell
node --test "tools/grid-bench/*.test.js"
```

Node.js 내장 테스트 러너만 쓰며 npm 패키지가 필요 없습니다. 가짜 VWorld 지도로 격자 생성, 좌표, 통계, 중복 실행 방지,
취소와 정리, 생성 오류 처리, 기존 지도 객체를 지우지 않는지, `map.clear()`를 부르지 않는지를 확인합니다.
**이 테스트가 통과해도 실제 VWorld 렌더링 성능에 대해서는 아무것도 말해 주지 않습니다.**
