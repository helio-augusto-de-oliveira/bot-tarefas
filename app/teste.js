const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJtYXNfaWQiOiI2YTE4NGJhMDg3Yjc3NzY4OTliNTM1MzMiLCJ1c2VyX2lkIjoiNmExODRiYTA4N2I3Nzc2ODk5YjUzNTMzIiwiZXh0ZXJuYWxfaWQiOiIyODQ1NjY1NDYiLCJza2V5IjoiYXV0aF90b2tlbjplZHVzcDpqb2FvbHVjYXN2aTEwOTg1NDM3Ny1zcCIsIm5pY2siOiJqb2FvbHVjYXN2aTEwOTg1NDM3Ny1zcCIsInJlYWxtIjoiZWR1c3AiLCJyb2xlIjoiMDAwNiIsImlhdCI6MTc4MDU0MzIyMCwiZXhwIjoxNzgwNjI5NjIwLCJhdWQiOiJ3ZWJjbGllbnQifQ.kxSlqLuwy9uHAfG06b4rh7KfLXu5EvZ_ejsz7Y1PaZM";

const params = new URLSearchParams({
    expired_only: "false",
    limit: "100",
    offset: "0",
    filter_expired: "true",
    is_exam: "false",
    with_answer: "true",
    is_essay: "false",
    answer_statuses: "draft",
    with_apply_moment: "true"
});

(async () => {
    try {
        const response = await fetch(
            `https://edusp-api.ip.tv/tms/task/todo?${params}`,
            {
                method: "GET",
                headers: {
                    "Accept": "application/json",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Content-Type": "application/json",
                    "Referer": "https://saladofuturo.educacao.sp.gov.br/",
                    "Origin": "https://saladofuturo.educacao.sp.gov.br",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
                    "request-id": "|4b33ef7666e1427db585e0927e7405fb.2cf6485bc17440b4",
                    "traceparent": "00-4b33ef7666e1427db585e0927e7405fb-2cf6485bc17440b4-01",
                    "x-api-key": token
                }
            }
        );

        console.log("Status:", response.status);
        console.log("Content-Type:", response.headers.get("content-type"));

        const text = await response.text();
        console.log(text);

    } catch (err) {
        console.error(err);
    }
})();